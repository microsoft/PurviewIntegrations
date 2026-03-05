import * as core from '@actions/core';
import * as github from '@actions/github';
import { ActionConfig, FileMetadata, BlockedFileResult, ExecutionMode, Activity, ProcessContentResponse } from '../config/types';
import { AuthenticationService } from '../auth/authenticationService';
import { FileProcessor } from '../file/fileProcessor';
import { PurviewClient } from '../api/purviewClient';
import { PayloadBuilder } from '../payload/payloadBuilder';
import { Logger } from '../utils/logger';
import { isBlocked, getBlockingActions } from '../utils/blockDetector';
import { PrCommentService } from '../utils/prCommentService';
import { FullScanService } from './fullScanService';

export class GitHubActionsRunner {
  private readonly logger: Logger;
  private readonly authService: AuthenticationService;
  private readonly fileProcessor: FileProcessor;
  private readonly purviewClient: PurviewClient;
  private readonly payloadBuilder: PayloadBuilder;
  private readonly fullScanService: FullScanService;
  
  constructor(private readonly config: ActionConfig) {
    this.logger = new Logger('GitHubActionsRunner');
    this.authService = new AuthenticationService(this.config);
    this.fileProcessor = new FileProcessor(this.config);
    this.purviewClient = new PurviewClient(this.config);
    this.payloadBuilder = new PayloadBuilder(this.config);
    this.fullScanService = new FullScanService(
      this.config,
      this.fileProcessor,
      this.purviewClient,
      this.payloadBuilder
    );
  }
  
  async execute(): Promise<void> {
    try {
      this.logger.info(`context: ${JSON.stringify(github.context)}`);
      this.logger.info(`Action event type: ${github.context.eventName}`);

      // Step 1: Setup state tracking and determine first run
      const { firstRun, stateInfo } = await this.fullScanService.setupStateTrackingAndDetectFirstRun();

      // Step 2: Authenticate
      this.logger.info('Authenticating with Azure');
      const token = await this.authService.getToken();
      this.purviewClient.setAuthToken(token.accessToken);
      
      // Step 3: Get PR info
      this.logger.info('Processing repository files');
      const prInfo = await this.fileProcessor.getPrInfo();

      const failedPayloads: string[] = [];
      const blockedFiles: BlockedFileResult[] = [];
      
      // Cache of userIds that returned 401 on User PS — skip them on subsequent calls
      const userPsDeniedCache = new Set<string>();

      // ─── Full Scan Path (first run) ───
      let fullScanFileCount = 0;
      if (firstRun) {
        fullScanFileCount = await this.fullScanService.performFullScan(stateInfo, failedPayloads, prInfo, userPsDeniedCache);
      }

      // ─── PR Diff Path (always runs) ───
      // Step 4: Process PR diff files
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

      // Step 5: Set outputs
      const totalProcessed = fullScanFileCount + diffFiles.length;
      core.setOutput('processed-files', totalProcessed);
      core.setOutput('failed-requests', failedPayloads.length);
      core.setOutput('blocked-files', JSON.stringify(blockedFiles.map(bf => bf.filePath)));
      
      // Step 6: Summary
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