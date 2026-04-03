import * as github from '@actions/github';
import { ActionConfig, FileMetadata, StateTrackingInfo, ApiResponse, ProtectionScopesResponse, PrInfo, ProtectionScopesRequest, CommitFiles } from '../config/types';
import { FileProcessor } from '../file/fileProcessor';
import { PurviewClient } from '../api/purviewClient';
import { PayloadBuilder } from '../payload/payloadBuilder';
import { Logger } from '../utils/logger';
import { StateService } from '../state/stateService';
import { tryParseWorkflowRepoFromEnv } from '../utils/workflowRepo';

export class FullScanService {
  private readonly logger: Logger;
  private readonly stateService: StateService;

  constructor(
    private readonly config: ActionConfig,
    private readonly fileProcessor: FileProcessor,
    private readonly purviewClient: PurviewClient,
    private readonly payloadBuilder: PayloadBuilder
  ) {
    this.logger = new Logger('FullScanService');
    this.stateService = new StateService(this.logger);
  }

  /**
   * Sets up state tracking configuration and determines if this is the first run
   */
  async setupStateTrackingAndDetectFirstRun(): Promise<{ 
    stateTrackingEnabled: boolean; 
    firstRun: boolean; 
    stateInfo?: StateTrackingInfo 
  }> {
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

    // Resolve default branch if needed
    if (stateTrackingEnabled && !stateRepoBranch) {
      stateRepoBranch = await this.resolveDefaultBranch(stateRepoToken, stateRepoOwner, stateRepoName);
    }

    // Verify/create configured branch if specified
    if (stateTrackingEnabled && stateRepoBranch && configuredBranch) {
      await this.ensureBranchExists(stateRepoToken, stateRepoOwner, stateRepoName, stateRepoBranch);
    }

    const stateTrackingEffective = stateTrackingEnabled && !!stateRepoBranch;

    // Determine if this is the first run
    const firstRun = await this.detectFirstRun(
      stateTrackingEffective,
      stateRepoToken,
      stateRepoOwner,
      stateRepoName,
      stateRepoBranch,
      statePath,
      targetOwner,
      targetRepo
    );

    const stateInfo = stateTrackingEffective ? {
      token: stateRepoToken,
      owner: stateRepoOwner,
      repo: stateRepoName,
      branch: stateRepoBranch,
      path: statePath
    } : undefined;

    return {
      stateTrackingEnabled: stateTrackingEffective,
      firstRun,
      stateInfo
    };
  }

  /**
   * Performs a full repository scan when it's the first run
   */
  async performFullScan(
    stateInfo: StateTrackingInfo | undefined,
    failedPayloads: string[],
    prInfo: PrInfo,
    userPsDeniedCache: Set<string>,
    userPsCache: Map<string, ApiResponse<ProtectionScopesResponse>>,
    currentEventSha?: string
  ): Promise<number> {
    this.logger.info(
      stateInfo
        ? 'First run detected; scanning full repository.'
        : 'State tracking disabled; scanning full repository.'
    );

    const allFiles = await this.fileProcessor.getAllRepoFiles(currentEventSha);
    const fullScanFileCount = allFiles.length;

    // Mark payloads as full-scan so AiAgentInfo uses email + "fullscan" version
    this.payloadBuilder.isFullScan = true;

    if (allFiles.length === 0) {
      this.logger.warn('No files found in repository for full scan');
      return fullScanFileCount;
    }

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
      await this.processFilesByUser(allFiles, prInfo, failedPayloads, psRequest, userPsDeniedCache, userPsCache);
    }

    // Process every git commit before the current event
    await this.processCommitsForFullScan(prInfo, failedPayloads, psRequest, userPsDeniedCache, userPsCache, currentEventSha);

    // Reset so subsequent diff-path payloads use normal agent version
    this.payloadBuilder.isFullScan = false;

    // Write state marker
    if (stateInfo) {
      await this.writeStateMarker(stateInfo);
    }

    return fullScanFileCount;
  }

  /**
   * Fetch repo commits *before* the current event boundary and send each
   * through the PCA / contentActivities pipeline, mirroring how the diff
   * path handles commit-level requests.
   */
  private async processCommitsForFullScan(
    prInfo: PrInfo,
    failedPayloads: string[],
    psRequest: ProtectionScopesRequest,
    userPsDeniedCache: Set<string>,
    userPsCache: Map<string, ApiResponse<ProtectionScopesResponse>>,
    currentEventSha?: string
  ): Promise<void> {
    const allCommits = await this.fileProcessor.getAllRepoCommits(currentEventSha);
    if (allCommits.length === 0) {
      this.logger.info('No commits to process during full scan');
      return;
    }
    this.logger.info(`Full scan: processing ${allCommits.length} commit(s)`);

    // Group commits by user so we can batch PCA calls per committer
    const commitsByUser = new Map<string, CommitFiles[]>();
    const fallbackCommits: CommitFiles[] = [];

    for (const commitGroup of allCommits) {
      const commitUserId = commitGroup.authorId || this.config.userId;

      if (userPsDeniedCache.has(commitUserId)) {
        this.logger.warn(`Skipping commit ${commitGroup.sha} — user ${commitUserId} cached 401.`);
        fallbackCommits.push(commitGroup);
        continue;
      }

      let userPsResponse = userPsCache.get(commitUserId);
      if (!userPsResponse) {
        userPsResponse = await this.purviewClient.searchUserProtectionScope(commitUserId, psRequest);
        if (userPsResponse.success) {
          userPsCache.set(commitUserId, userPsResponse);
        }
      }

      if (!userPsResponse.success) {
        this.logger.error(`User PS failed for commit ${commitGroup.sha}, user ${commitUserId}: ${userPsResponse.error}`);
        failedPayloads.push(`ps-fullscan-commit-${commitGroup.sha}`);
        if (userPsResponse.statusCode === 401) {
          userPsDeniedCache.add(commitUserId);
        }
        fallbackCommits.push(commitGroup);
        continue;
      }

      if (!userPsResponse.data?.value || userPsResponse.data.value.length === 0) {
        this.logger.warn(`No scopes for commit ${commitGroup.sha}, user ${commitUserId}. Falling back to contentActivities.`);
        fallbackCommits.push(commitGroup);
        continue;
      }

      const existing = commitsByUser.get(commitUserId) || [];
      existing.push(commitGroup);
      commitsByUser.set(commitUserId, existing);
    }

    // Send fallback commits via contentActivities
    for (const commitGroup of fallbackCommits) {
      await this.sendCommitContentActivity(commitGroup, prInfo, failedPayloads);
    }

    // Send batched PCA calls per user
    for (const [userId, userCommits] of commitsByUser) {
      const pcaBatches = this.payloadBuilder.buildCommitProcessContentBatchRequest(userCommits);
      this.logger.info(`Full scan: sending ${userCommits.length} commit(s) in ${pcaBatches.length} PCA batch(es) for user ${userId}`);

      for (const pcaBatch of pcaBatches) {
        const pcaResult = await this.purviewClient.processContentAsync(pcaBatch);

        if (!pcaResult.success) {
          this.logger.error(`PCA batch failed for user ${userId}: ${pcaResult.error}. Falling back to contentActivities for ${userCommits.length} commit(s).`);
          failedPayloads.push(`pca-fullscan-commits-${userId}`);
          for (const commitGroup of userCommits) {
            await this.sendCommitContentActivity(commitGroup, prInfo, failedPayloads);
          }
          break;
        }
      }
    }
  }

  private async sendCommitContentActivity(commitGroup: CommitFiles, prInfo: PrInfo, failedPayloads: string[]): Promise<void> {
    const requests = this.payloadBuilder.buildCommitUploadSignalRequest(commitGroup, prInfo);
    for (const req of requests) {
      const result = await this.purviewClient.uploadSignal(req);
      if (!result.success) {
        this.logger.error(`ContentActivities upload failed for commit ${commitGroup.sha}: ${result.error}`);
        failedPayloads.push(`ca-fullscan-commit-${commitGroup.sha}`);
      }
    }
  }

  private async resolveDefaultBranch(token: string, owner: string, repo: string): Promise<string> {
    try {
      const octokit = github.getOctokit(token);
      const { data } = await octokit.rest.repos.get({ owner, repo });
      this.logger.info(`Resolved workflow repo default branch as ${data.default_branch}`);
      return data.default_branch;
    } catch (e) {
      this.logger.warn('Failed to resolve workflow repo default branch; state tracking disabled.', { error: e });
      return '';
    }
  }

  private async ensureBranchExists(token: string, owner: string, repo: string, branch: string): Promise<void> {
    try {
      const octokit = github.getOctokit(token);
      try {
        await octokit.rest.repos.getBranch({ owner, repo, branch });
        this.logger.info(`State repo branch '${branch}' exists.`);
      } catch (branchErr: any) {
        if (branchErr?.status === 404) {
          this.logger.info(`State repo branch '${branch}' not found. Creating from default branch.`);
          // Get default branch SHA
          const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
          const defaultBranch = repoData.default_branch;
          const { data: refData } = await octokit.rest.git.getRef({
            owner,
            repo,
            ref: `heads/${defaultBranch}`,
          });
          // Create the new branch
          await octokit.rest.git.createRef({
            owner,
            repo,
            ref: `refs/heads/${branch}`,
            sha: refData.object.sha,
          });
          this.logger.info(`Created branch '${branch}' from '${defaultBranch}' (${refData.object.sha}).`);
        } else {
          throw branchErr;
        }
      }
    } catch (e) {
      this.logger.warn(`Failed to verify/create state repo branch '${branch}'; state tracking may fail.`, { error: e });
    }
  }

  private async detectFirstRun(
    stateTrackingEffective: boolean,
    stateRepoToken: string,
    stateRepoOwner: string,
    stateRepoName: string,
    stateRepoBranch: string,
    statePath: string,
    targetOwner: string,
    targetRepo: string
  ): Promise<boolean> {
    if (stateTrackingEffective) {
      const lookup = await this.stateService.lookupStateFile({
        owner: stateRepoOwner,
        repo: stateRepoName,
        branch: stateRepoBranch,
        token: stateRepoToken,
      }, statePath);
      return !lookup.exists;
    } else {
      // State tracking not enabled - check workflow history to determine if this is first run
      return await this.detectFirstRunFromWorkflowHistory(targetOwner, targetRepo);
    }
  }

  private async detectFirstRunFromWorkflowHistory(targetOwner: string, targetRepo: string): Promise<boolean> {
    try {
      const githubToken = process.env['GITHUB_TOKEN'] || '';
      if (!githubToken) {
        this.logger.warn('GITHUB_TOKEN not available for workflow history check, defaulting to non-first run');
        return false;
      }

      const octokit = github.getOctokit(githubToken);
      
      // Try to get workflow file path from GITHUB_WORKFLOW_REF
      let workflowId = '';
      const workflowRef = process.env['GITHUB_WORKFLOW_REF'] || '';
      
      if (workflowRef) {
        // GITHUB_WORKFLOW_REF format: "octo-org/hello-world/.github/workflows/my-workflow.yml@refs/heads/main"
        // Extract just the filename — octokit URL-encodes slashes in the full path, causing 404
        const refMatch = workflowRef.match(/\.github\/workflows\/([^@]+)/);
        if (refMatch && refMatch[1]) {
          workflowId = refMatch[1];
          this.logger.info(`Extracted workflow filename from GITHUB_WORKFLOW_REF: ${workflowId}`);
        }
      }
      
      // Fallback to github.context.workflow if available
      if (!workflowId && github.context.workflow) {
        workflowId = github.context.workflow;
        this.logger.info(`Using workflow from github.context: ${workflowId}`);
      }
      
      if (!workflowId) {
        this.logger.warn('Could not determine workflow file path from GITHUB_WORKFLOW_REF or github.context, defaulting to non-first run');
        return false;
      }

      // Resolve the numeric workflow ID from the current run
      const runId = parseInt(github.context.runId.toString(), 10);
      let numericWorkflowId: number | null = null;
      if (runId) {
        try {
          const { data: run } = await octokit.rest.actions.getWorkflowRun({
            owner: targetOwner,
            repo: targetRepo,
            run_id: runId,
          });
          numericWorkflowId = run.workflow_id;
          this.logger.info(`Resolved workflow ID ${numericWorkflowId} from current run ${runId}`);
        } catch (err) {
          this.logger.warn('Failed to resolve workflow ID from current run', { error: err });
        }
      }
      if (numericWorkflowId === null) {
        this.logger.info('Could not resolve workflow ID — defaulting to first run');
        return true;
      }

      // Use listWorkflowRunsForRepo (not listWorkflowRuns) because in
      // cross-repo reusable-workflow setups the numeric workflow_id belongs
      // to the external workflow-definition repo, causing 404 on the
      // per-workflow endpoint.
      const { data: allRuns } = await octokit.rest.actions.listWorkflowRunsForRepo({
        owner: targetOwner,
        repo: targetRepo,
        status: 'success' as any,
        per_page: 20,
      });

      const matchingCount = allRuns.workflow_runs.filter(
        (r: any) => r.workflow_id === numericWorkflowId
      ).length;

      // If there are no completed runs for our workflow, this is the first run
      const firstRun = matchingCount === 0;

      this.logger.info(firstRun
        ? 'First workflow run detected based on workflow history'
        : `Previous workflow runs found (${matchingCount} successful run(s) in first page), not first run`
      );
      
      return firstRun;
    } catch (error: any) {
      if (error?.status === 404) {
        this.logger.warn(
          'Workflow history returned 404. Ensure the workflow has "actions: read" permission ' +
          '(add `permissions: { actions: read }` to your workflow YAML). Defaulting to non-first run.'
        );
      } else {
        this.logger.warn('Failed to check workflow history, defaulting to non-first run', { error });
      }
      return false;
    }
  }

  private async processFilesByUser(
    allFiles: FileMetadata[],
    prInfo: PrInfo,
    failedPayloads: string[],
    psRequest: ProtectionScopesRequest,
    userPsDeniedCache: Set<string>,
    userPsCache: Map<string, ApiResponse<ProtectionScopesResponse>>
  ): Promise<void> {
    const filesByUser = new Map<string, FileMetadata[]>();
    for (const file of allFiles) {
      const userId = file.authorId || this.config.userId;
      const existing = filesByUser.get(userId) || [];
      existing.push(file);
      filesByUser.set(userId, existing);
    }

    for (const [userId, userFiles] of filesByUser) {
      this.logger.info(`Full scan: processing ${userFiles.length} file(s) for user ${userId}`);

      // Call per-user protection scopes (check cache first)
      let userPsResponse = userPsCache.get(userId);
      if (userPsResponse) {
        this.logger.debug(`Full scan: using cached PS response for user ${userId}`);
      } else {
        userPsResponse = await this.purviewClient.searchUserProtectionScope(userId, psRequest);
        if (userPsResponse.success) {
          userPsCache.set(userId, userPsResponse);
        }
      }

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
      const pcaBatchRequests = this.payloadBuilder.buildProcessContentBatchRequest(userFiles);
      const committerEmail = userFiles.find(f => f.committerEmail)?.committerEmail || 'unknown';
      this.logger.info(`Full scan: sending ${userFiles.length} file(s) in ${pcaBatchRequests.length} PCA batch(es) for user ${userId} (committer: ${committerEmail})`);
      for (let i = 0; i < pcaBatchRequests.length; i++) {
        const pcaBatchRequest = pcaBatchRequests[i]!;
        const pcaResult = await this.purviewClient.processContentAsync(pcaBatchRequest);

        if (!pcaResult.success) {
          this.logger.error(`PCA batch ${i + 1}/${pcaBatchRequests.length} failed for user ${userId}: ${pcaResult.error}. Falling back to contentActivities.`);
          failedPayloads.push(`pca-fullscan-${userId}`);
          await this.sendContentActivities(userFiles, prInfo, failedPayloads);
          break;
        } else {
          this.logger.debug(`Full scan PCA batch ${i + 1}/${pcaBatchRequests.length} completed for user ${userId}`);
        }
      }
    }
  }

  private async writeStateMarker(stateInfo: StateTrackingInfo): Promise<void> {
    try {
      const state = {
        version: 1,
        targetRepository: `${this.config.repository.owner}/${this.config.repository.repo}`,
        initializedAt: new Date().toISOString(),
        initializedByRunId: this.config.repository.runId,
        initializedByCommit: this.config.repository.sha,
      };

      await this.stateService.writeStateFile({
        owner: stateInfo.owner,
        repo: stateInfo.repo,
        branch: stateInfo.branch,
        token: stateInfo.token,
      }, stateInfo.path, state, `Initialize Purview scan state for ${this.config.repository.owner}/${this.config.repository.repo}`);

      this.logger.info('State marker written successfully');
    } catch (e) {
      this.logger.warn('Failed to write state marker file (non-fatal).', { error: e });
    }
  }

  private async sendContentActivities(files: FileMetadata[], prInfo: PrInfo, failedPayloads: string[]): Promise<void> {
    const uploadRequests = this.payloadBuilder.buildUploadSignalRequest(files, prInfo);
    for (const req of uploadRequests) {
      const result = await this.purviewClient.uploadSignal(req);
      if (!result.success) {
        this.logger.error(`ContentActivities upload failed for ${req.contentMetadata.contentEntries[0]?.identifier}: ${result.error}`);
        failedPayloads.push(req.id);
      }
    }
  }
}