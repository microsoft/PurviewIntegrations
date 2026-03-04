import * as core from '@actions/core';
import * as github from '@actions/github';
import { ActionConfig, FileMetadata, BlockedFileResult, ExecutionMode, Activity, ProcessContentResponse } from '../config/types';
import { AuthenticationService } from '../auth/authenticationService';
import { FileProcessor } from '../file/fileProcessor';
import { PurviewClient } from '../api/purviewClient';
import { PayloadBuilder } from '../payload/payloadBuilder';
import { Logger } from '../utils/logger';
import { StateService } from '../state/stateService';
import { tryParseWorkflowRepoFromEnv } from '../utils/workflowRepo';
import { isBlocked, getBlockingActions } from '../utils/blockDetector';
import { PrCommentService } from '../utils/prCommentService';

export class GitHubActionsRunner {
  private readonly logger: Logger;
  private readonly authService: AuthenticationService;
  private readonly fileProcessor: FileProcessor;
  private readonly purviewClient: PurviewClient;
  private readonly payloadBuilder: PayloadBuilder;
  
  constructor(private readonly config: ActionConfig) {
    this.logger = new Logger('GitHubActionsRunner');
    this.authService = new AuthenticationService(this.config);
    this.fileProcessor = new FileProcessor(this.config);
    this.purviewClient = new PurviewClient(this.config);
    this.payloadBuilder = new PayloadBuilder(this.config);
  }
  
  async execute(): Promise<void> {
    try {
      this.logger.info(`Action event type: ${github.context.eventName}`);

      const stateService = new StateService(this.logger);

      const targetOwner = this.config.repository.owner;
      const targetRepo = this.config.repository.repo;

      const stateTrackingTokenPresent = !!(this.config.stateRepoToken && this.config.stateRepoToken.length > 0);
      const statePath = StateService.defaultStatePathForTarget(targetOwner, targetRepo);

      const workflowRepo = tryParseWorkflowRepoFromEnv();
      if (stateTrackingTokenPresent && !workflowRepo) {
        this.logger.warn('State tracking token provided but GITHUB_WORKFLOW_REF is missing/unparseable; state tracking disabled.');
      }

      const workflowRepoIsTarget = !!workflowRepo &&
        workflowRepo.owner.toLowerCase() === targetOwner.toLowerCase() &&
        workflowRepo.repo.toLowerCase() === targetRepo.toLowerCase();
      if (stateTrackingTokenPresent && workflowRepoIsTarget) {
        this.logger.warn('State tracking token provided but workflow-definition repo is the scanned repo; state tracking disabled (no same-repo updates supported).');
      }

      const stateRepoToken = (this.config.stateRepoToken || '').trim();
      const stateRepoOwner = workflowRepo?.owner || '';
      const stateRepoName = workflowRepo?.repo || '';

      const configuredBranch = (this.config.stateRepoBranch || '').trim();
      let stateRepoBranch = configuredBranch;

      const stateTrackingEnabled = stateTrackingTokenPresent && !!workflowRepo && !workflowRepoIsTarget;
      if (stateTrackingEnabled && !stateRepoBranch) {
        try {
          const octokit = github.getOctokit(stateRepoToken);
          const { data } = await octokit.rest.repos.get({
            owner: stateRepoOwner,
            repo: stateRepoName,
          });
          stateRepoBranch = data.default_branch;
          this.logger.info(`Resolved workflow repo default branch as ${stateRepoBranch}`);
        } catch (e) {
          this.logger.warn('Failed to resolve workflow repo default branch; state tracking disabled.', { error: e });
          stateRepoBranch = '';
        }
      }

      // If a specific branch is configured, verify it exists; create it from the default branch if not
      if (stateTrackingEnabled && stateRepoBranch && configuredBranch) {
        try {
          const octokit = github.getOctokit(stateRepoToken);
          try {
            await octokit.rest.repos.getBranch({
              owner: stateRepoOwner,
              repo: stateRepoName,
              branch: stateRepoBranch,
            });
            this.logger.info(`State repo branch '${stateRepoBranch}' exists.`);
          } catch (branchErr: any) {
            if (branchErr?.status === 404) {
              this.logger.info(`State repo branch '${stateRepoBranch}' not found. Creating from default branch.`);
              // Get default branch SHA
              const { data: repoData } = await octokit.rest.repos.get({
                owner: stateRepoOwner,
                repo: stateRepoName,
              });
              const defaultBranch = repoData.default_branch;
              const { data: refData } = await octokit.rest.git.getRef({
                owner: stateRepoOwner,
                repo: stateRepoName,
                ref: `heads/${defaultBranch}`,
              });
              // Create the new branch
              await octokit.rest.git.createRef({
                owner: stateRepoOwner,
                repo: stateRepoName,
                ref: `refs/heads/${stateRepoBranch}`,
                sha: refData.object.sha,
              });
              this.logger.info(`Created branch '${stateRepoBranch}' from '${defaultBranch}' (${refData.object.sha}).`);
            } else {
              throw branchErr;
            }
          }
        } catch (e) {
          this.logger.warn(`Failed to verify/create state repo branch '${stateRepoBranch}'; state tracking may fail.`, { error: e });
        }
      }

      const stateTrackingEffective = stateTrackingEnabled && !!stateRepoBranch;

      let firstRun = false;
      if (stateTrackingEffective) {
        const lookup = await stateService.lookupStateFile({
          owner: stateRepoOwner,
          repo: stateRepoName,
          branch: stateRepoBranch,
          token: stateRepoToken,
        }, statePath);
        firstRun = !lookup.exists;
      } else {
        // State tracking not enabled - check workflow history to determine if this is first run
        try {
          const githubToken = process.env['GITHUB_TOKEN'] || '';
          if (githubToken) {
            const octokit = github.getOctokit(githubToken);
            const workflowPath = process.env['GITHUB_WORKFLOW'] || '';
            
            if (workflowPath) {
              // Extract just the filename from the workflow path (e.g., ".github/workflows/ci.yml" -> "ci.yml")
              const workflowFile = workflowPath.split('/').pop() || workflowPath;
              
              const { data: workflowRuns } = await octokit.rest.actions.listWorkflowRuns({
                owner: targetOwner,
                repo: targetRepo,
                workflow_id: workflowFile,
                status: 'completed',
                per_page: 2,
              });

              this.logger.info(`workflowRuns: ${JSON.stringify(workflowRuns)}`);
              
              // If there are no completed runs, this is the first run
              firstRun = workflowRuns.total_count === 0;
              
              this.logger.info(firstRun 
                ? 'First workflow run detected based on workflow history'
                : `Previous workflow runs found (${workflowRuns.total_count} completed runs), not first run`
              );
            } else {
              this.logger.warn('GITHUB_WORKFLOW environment variable not available, defaulting to non-first run');
              firstRun = false;
            }
          } else {
            this.logger.warn('GITHUB_TOKEN not available for workflow history check, defaulting to non-first run');
            firstRun = false;
          }
        } catch (error) {
          this.logger.warn('Failed to check workflow history, defaulting to non-first run', { error });
          firstRun = false;
        }
      }

      // Step 1: Authenticate
      this.logger.info('Authenticating with Azure');
      const token = await this.authService.getToken();
      this.purviewClient.setAuthToken(token.accessToken);
      
      // Step 2: Get PR info
      this.logger.info('Processing repository files');
      const prInfo = await this.fileProcessor.getPrInfo();

      const failedPayloads: string[] = [];
      const blockedFiles: BlockedFileResult[] = [];
      let fullScanFileCount = 0;

      // Cache of userIds that returned 401 on User PS — skip them on subsequent calls
      const userPsDeniedCache = new Set<string>();

      // ─── Full Scan Path (first run) ───
      if (firstRun) {
        this.logger.info(
          stateTrackingEffective
            ? 'First run detected; scanning full repository.'
            : 'State tracking disabled; scanning full repository.'
        );

        const allFiles = await this.fileProcessor.getAllRepoFiles();
        fullScanFileCount = allFiles.length;

        if (allFiles.length === 0) {
          this.logger.warn('No files found in repository for full scan');
        } else {
          // Call tenant protection scopes
          const psRequest = this.payloadBuilder.buildProtectionScopesRequest();
          this.logger.info('Calling searchTenantProtectionScope for full scan');
          const tenantPsResponse = await this.purviewClient.searchTenantProtectionScope(psRequest);

          if (!tenantPsResponse.success) {
            // Tenant PS failed → fallback: contentActivities for ALL files
            this.logger.error(`Tenant PS failed: ${tenantPsResponse.error}. Falling back to contentActivities for all ${allFiles.length} file(s).`);
            failedPayloads.push('tenant-ps');
            await this.sendContentActivities(allFiles, prInfo, failedPayloads);
          } else if (!tenantPsResponse.data?.value || tenantPsResponse.data.value.length === 0) {
            // Tenant PS has no scopes → contentActivities for ALL files
            this.logger.warn('Tenant PS returned no protection scopes. Falling back to contentActivities for all files.');
            await this.sendContentActivities(allFiles, prInfo, failedPayloads);
          } else {
            // Tenant PS has scopes → group files by user and call per-user PS + PCA
            this.logger.info(`Tenant PS returned ${tenantPsResponse.data.value.length} scope(s). Grouping files by user for per-user PS + PCA.`);

            const filesByUser = new Map<string, FileMetadata[]>();
            for (const file of allFiles) {
              const userId = file.authorId || this.config.userId;
              const existing = filesByUser.get(userId) || [];
              existing.push(file);
              filesByUser.set(userId, existing);
            }

            for (const [userId, userFiles] of filesByUser) {
              this.logger.info(`Full scan: processing ${userFiles.length} file(s) for user ${userId}`);

              // Call per-user protection scopes
              const userPsResponse = await this.purviewClient.searchUserProtectionScope(userId, psRequest);

              if (!userPsResponse.success) {
                this.logger.error(`User PS failed for ${userId}: ${userPsResponse.error}. Falling back to contentActivities.`);
                failedPayloads.push(`ps-fullscan-${userId}`);
                // Cache 401s so we don't retry this user in the diff path
                if (userPsResponse.statusCode === 401) {
                  userPsDeniedCache.add(userId);
                  this.logger.warn(`User ${userId} returned 401 on PS — cached, will skip in future calls.`);
                }
                await this.sendContentActivities(userFiles, prInfo, failedPayloads);
                continue;
              }

              if (!userPsResponse.data?.value || userPsResponse.data.value.length === 0) {
                this.logger.warn(`User PS returned no scopes for ${userId}. Falling back to contentActivities.`);
                await this.sendContentActivities(userFiles, prInfo, failedPayloads);
                continue;
              }

              // User has scopes → send PCA batch
              const pcaBatchRequest = this.payloadBuilder.buildProcessContentBatchRequest(userFiles, prInfo);
              this.logger.info(`Full scan: sending ${userFiles.length} file(s) to PCA batch for user ${userId}`);
              const pcaResult = await this.purviewClient.processContentAsync(pcaBatchRequest);

              if (!pcaResult.success) {
                this.logger.error(`PCA batch failed for user ${userId}: ${pcaResult.error}. Falling back to contentActivities.`);
                failedPayloads.push(`pca-fullscan-${userId}`);
                await this.sendContentActivities(userFiles, prInfo, failedPayloads);
              } else {
                this.logger.info(`Full scan PCA batch completed for user ${userId}`);
              }
            }
          }
        }

        // Write state marker
        if (stateTrackingEffective) {
          try {
            const state = {
              version: 1,
              targetRepository: `${targetOwner}/${targetRepo}`,
              initializedAt: new Date().toISOString(),
              initializedByRunId: this.config.repository.runId,
              initializedByCommit: this.config.repository.sha,
            };

            await stateService.writeStateFile({
              owner: stateRepoOwner,
              repo: stateRepoName,
              branch: stateRepoBranch,
              token: stateRepoToken,
            }, statePath, state, `Initialize Purview scan state for ${targetOwner}/${targetRepo}`);

            this.logger.info('State marker written successfully');
          } catch (e) {
            this.logger.warn('Failed to write state marker file (non-fatal).', { error: e });
          }
        }
      }

      // ─── PR Diff Path (always runs) ───
      this.logger.info('Running PR diff flow');
      const diffFiles = await this.fileProcessor.getLatestPushFiles();

      if (diffFiles.length === 0) {
        this.logger.warn('No changed files found for PR diff');
      } else {
        // Group files by userId
        const filesByUser = new Map<string, FileMetadata[]>();
        for (const file of diffFiles) {
          const userId = file.authorId || this.config.userId;
          const existing = filesByUser.get(userId) || [];
          existing.push(file);
          filesByUser.set(userId, existing);
        }

        this.logger.info(`PR diff: ${diffFiles.length} file(s) across ${filesByUser.size} user(s)`);

        const psRequest = this.payloadBuilder.buildProtectionScopesRequest();
        const requestLocation = psRequest.locations?.[0];

        // Process each user's files
        for (const [userId, userFiles] of filesByUser) {
          this.logger.info(`Processing ${userFiles.length} file(s) for user ${userId}`);

          // Check User PS denial cache (401 from earlier call)
          if (userPsDeniedCache.has(userId)) {
            this.logger.warn(`Skipping user ${userId} — cached 401 from earlier PS call. Routing to contentActivities.`);
            await this.sendContentActivities(userFiles, prInfo, failedPayloads);
            continue;
          }

          // Call per-user protection scopes
          const psApiResponse = await this.purviewClient.searchUserProtectionScope(userId, psRequest);

          if (!psApiResponse.success) {
            this.logger.error(`Failed to get protection scopes for user ${userId}: ${psApiResponse.error}`);
            failedPayloads.push(`ps-${userId}`);
            // Cache 401s so we don't retry this user
            if (psApiResponse.statusCode === 401) {
              userPsDeniedCache.add(userId);
              this.logger.warn(`User ${userId} returned 401 on PS — cached, will skip in future calls.`);
            }
            await this.sendContentActivities(userFiles, prInfo, failedPayloads);
            continue;
          }

          const psResponse = psApiResponse.data;
          const scopeIdentifier = psApiResponse.etag || '';

          if (!psResponse || !psResponse.value) {
            this.logger.warn(`Empty protection scopes response for user ${userId}, routing all files to contentActivities`);
            await this.sendContentActivities(userFiles, prInfo, failedPayloads);
            continue;
          }

          // Check applicable scopes
          const scopeCheck = this.payloadBuilder.checkApplicableScopes(
            psResponse.value,
            Activity.uploadText,
            requestLocation!
          );

          if (!scopeCheck.shouldProcess) {
            // No matching scopes → contentActivities (fire-and-forget)
            this.logger.info(`No matching scopes for user ${userId}, routing ${userFiles.length} file(s) to contentActivities`);
            await this.sendContentActivities(userFiles, prInfo, failedPayloads);
            continue;
          }

          // Matching scopes found — route based on execution mode
          if (scopeCheck.executionMode === ExecutionMode.evaluateInline) {
            // evaluateInline → per-user PC, synchronous, parse for blocks
            this.logger.info(`evaluateInline: calling processContent for ${userFiles.length} file(s), user ${userId}`);

            const conversationId = crypto.randomUUID();

            for (let i = 0; i < userFiles.length; i++) {
              const file = userFiles[i]!;
              const pcRequest = this.payloadBuilder.buildPerUserProcessContentRequest(file, prInfo, conversationId, i);

              let pcResponse = await this.purviewClient.processContent(userId, pcRequest, scopeIdentifier, true);

              if (!pcResponse.success) {
                this.logger.error(`PC failed for file ${file.path}: ${pcResponse.error}. Falling back to contentActivities.`);
                failedPayloads.push(`pc-${file.path}`);
                await this.sendContentActivities([file], prInfo, failedPayloads);
                continue;
              }

              const pcData = pcResponse.data as ProcessContentResponse;

              // Handle protectionScopeState: "modified" → re-fetch scopes and retry
              if (pcData?.protectionScopeState === 'modified') {
                this.logger.info(`Protection scope state modified for user ${userId}, re-fetching scopes and retrying PC for ${file.path}`);

                const freshPsResponse = await this.purviewClient.searchUserProtectionScope(userId, psRequest);
                if (freshPsResponse.success && freshPsResponse.data) {
                  const freshScopeId = freshPsResponse.etag || '';
                  pcResponse = await this.purviewClient.processContent(userId, pcRequest, freshScopeId, true);

                  if (!pcResponse.success) {
                    this.logger.error(`PC retry failed for file ${file.path}: ${pcResponse.error}`);
                    failedPayloads.push(`pc-retry-${file.path}`);
                    continue;
                  }
                }
              }

              // Check for block actions
              const responseData = pcResponse.data as ProcessContentResponse;
              if (responseData && isBlocked(responseData)) {
                const blockingActions = getBlockingActions(responseData);
                this.logger.warn(`BLOCKED: File ${file.path} blocked by ${blockingActions.length} policy action(s)`);
                blockedFiles.push({
                  filePath: file.path,
                  userId,
                  policyActions: blockingActions,
                });
              }
            }
          } else {
            // evaluateOffline → PCA batch (fire-and-forget)
            this.logger.info(`evaluateOffline: sending ${userFiles.length} file(s) to PCA batch for user ${userId}`);
            const pcaBatchRequest = this.payloadBuilder.buildProcessContentBatchRequest(userFiles, prInfo);
            const pcaResult = await this.purviewClient.processContentAsync(pcaBatchRequest);

            if (!pcaResult.success) {
              this.logger.error(`PCA batch failed for user ${userId}: ${pcaResult.error}. Falling back to contentActivities.`);
              failedPayloads.push(`pca-${userId}`);
              await this.sendContentActivities(userFiles, prInfo, failedPayloads);
            }
          }
        }

        // Post PR review comment if any files were blocked
        if (blockedFiles.length > 0 && prInfo.url) {
          this.logger.info(`${blockedFiles.length} file(s) blocked, posting PR review comment`);

          try {
            const githubToken = process.env['GITHUB_TOKEN'] || '';
            const prNumber = parseInt(prInfo.url?.split('/').pop() || '0', 10);

            if (githubToken && prNumber > 0) {
              const octokit = github.getOctokit(githubToken);
              const prCommentService = new PrCommentService(
                octokit,
                this.config.repository.owner,
                this.config.repository.repo,
                prNumber
              );
              await prCommentService.postBlockedFilesReview(blockedFiles);
            } else {
              this.logger.warn('Cannot post PR comment: missing GITHUB_TOKEN or PR number');
            }
          } catch (e) {
            this.logger.warn('Failed to post PR review comment (non-fatal).', { error: e });
          }
        }
      }

      // Step 6: Set outputs
      const totalProcessed = fullScanFileCount + diffFiles.length;
      core.setOutput('processed-files', totalProcessed);
      core.setOutput('failed-requests', failedPayloads.length);
      core.setOutput('blocked-files', JSON.stringify(blockedFiles.map(bf => bf.filePath)));
      
      // Summary
      await this.createSummary(totalProcessed, failedPayloads, blockedFiles);
      
    } catch (error) {
      this.logger.error('Execution failed', { error });
      throw error;
    }
  }
  
  private async sendContentActivities(files: FileMetadata[], prInfo: any, failedPayloads: string[]): Promise<void> {
    const uploadRequests = this.payloadBuilder.buildUploadSignalRequest(files, prInfo);
    for (const req of uploadRequests) {
      const result = await this.purviewClient.uploadSignal(req);
      if (!result.success) {
        this.logger.error(`ContentActivities upload failed for ${req.contentMetadata.contentEntries[0]?.identifier}: ${result.error}`);
        failedPayloads.push(req.id);
      }
    }
  }

  private async createSummary(processed: number, failed: string[], blocked: BlockedFileResult[] = []): Promise<void> {
    const summary = core.summary
      .addHeading('Purview GitHub Action Results')
      .addRaw(`Successfully processed ${processed} files.`);
    
    if (failed.length > 0) {
      summary.addHeading('Failed Requests', 3);
      summary.addList(failed);
    }

    if (blocked.length > 0) {
      summary.addHeading('Blocked Files', 3);
      summary.addTable([
        [{ data: 'File', header: true }, { data: 'Policy', header: true }, { data: 'Action', header: true }],
        ...blocked.flatMap(bf =>
          bf.policyActions.map(pa => [
            bf.filePath,
            pa.policyName || pa.policyId || 'Unknown',
            pa.restrictionAction || pa.action,
          ])
        ),
      ]);
    }
    
    await summary.write();
  }
}