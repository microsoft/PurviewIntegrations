import * as core from '@actions/core';
import * as github from '@actions/github';
import { ActionConfig, FileMetadata, BlockedFileResult, ExecutionMode, Activity, ProcessContentResponse, ApiResponse, ProtectionScopesResponse, CommitFiles, PrInfo, ProtectionScopesRequest, PolicyLocation } from '../config/types';
import { AuthenticationService } from '../auth/authenticationService';
import { FileProcessor } from '../file/fileProcessor';
import { PurviewClient } from '../api/purviewClient';
import { PayloadBuilder } from '../payload/payloadBuilder';
import { Logger } from '../utils/logger';
import { isBlocked, getBlockingActions } from '../utils/blockDetector';
import { PrCommentService } from '../utils/prCommentService';
import { FullScanService } from './fullScanService';

/** Shared state passed between methods during diff path processing. */
interface DiffPathContext {
  prInfo: PrInfo;
  psRequest: ProtectionScopesRequest;
  requestLocation: PolicyLocation;
  failedPayloads: string[];
  blockedFiles: BlockedFileResult[];
  userPsDeniedCache: Set<string>;
  userPsCache: Map<string, ApiResponse<ProtectionScopesResponse>>;
}

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
      this.logger.info(`Action event type: ${github.context.eventName}`);

      // Step 1: Setup state tracking and determine first run
      const { firstRun, stateInfo } = await this.fullScanService.setupStateTrackingAndDetectFirstRun();

      // Step 2: Authenticate
      this.logger.info('Authenticating with Azure');
      const token = await this.authService.getToken();
      this.purviewClient.setAuthToken(token.accessToken);
      this.purviewClient.setTokenProvider(async () => {
        const freshToken = await this.authService.getToken();
        return freshToken.accessToken;
      });
      this.purviewClient.setTokenRefresh(() => this.authService.clearCache());
      
      // Step 3: Get event context info
      this.logger.info('Processing repository files');
      const prInfo = await this.fileProcessor.getPrInfo();
      this.payloadBuilder.prNumber = prInfo.prNumber;
      this.payloadBuilder.prDescription = prInfo.body;

      const failedPayloads: string[] = [];
      const blockedFiles: BlockedFileResult[] = [];
      const userPsDeniedCache = new Set<string>();
      const userPsCache = new Map<string, ApiResponse<ProtectionScopesResponse>>();

      // ─── Full Scan Path (first run or manual workflow dispatch) ───
      let fullScanFileCount = 0;
      const isManualDispatch = github.context.eventName === 'workflow_dispatch';
      const shouldPerformFullScan = firstRun || isManualDispatch;
      
      if (shouldPerformFullScan) {
        if (isManualDispatch && !firstRun) {
          this.logger.info('Performing full scan (manually triggered via workflow_dispatch)');
        }
        // Determine the boundary SHA so the full scan covers only commits
        // *before* the current event (the diff path handles the rest).
        const currentEventSha = this.resolveCurrentEventBoundarySha();
        fullScanFileCount = await this.fullScanService.performFullScan(stateInfo, failedPayloads, prInfo, userPsDeniedCache, userPsCache, currentEventSha);
      }

      // ─── Diff Path (skip if manually triggered) ───
      let diffFileCount = 0;
      if (!isManualDispatch) {
        diffFileCount = await this.processDiffPath(prInfo, failedPayloads, blockedFiles, userPsDeniedCache, userPsCache);
      } else {
        this.logger.info('Skipping diff processing (manually triggered workflow)');
      }

      // ─── Outputs & Summary ───
      const totalProcessed = fullScanFileCount + diffFileCount;
      this.logger.info(`Completed: ${totalProcessed} file(s) processed, ${failedPayloads.length} failed, ${blockedFiles.length} blocked`);
      core.setOutput('processed-files', totalProcessed);
      core.setOutput('failed-requests', failedPayloads.length);
      core.setOutput('blocked-files', JSON.stringify(blockedFiles.map(bf => bf.filePath)));
      
      await this.createSummary(totalProcessed, failedPayloads, blockedFiles);
      
      if (blockedFiles.length > 0) {
        const blockedFilePaths = blockedFiles.map(bf => bf.filePath).join(', ');
        const message = `Action failed: ${blockedFiles.length} file(s) were blocked by data security policies: ${blockedFilePaths}`;
        this.logger.error(message);
        core.setFailed(message);
      }
      
    } catch (error) {
      this.logger.error('Execution failed', { error });
      throw error;
    }
  }

  /**
   * Return the SHA that marks the boundary between "history" (for full scan)
   * and "current event" (for diff path).
   * - push: payload.before (the parent of the first pushed commit)
   * - pull_request: the PR base SHA
   * - workflow_dispatch / other: undefined (no boundary — full scan gets everything)
   */
  private resolveCurrentEventBoundarySha(): string | undefined {
    const payload = github.context.payload;
    if (github.context.eventName === 'push') {
      const before = payload['before'] as string | undefined;
      if (before && !/^0+$/.test(before)) {
        return before;
      }
    }
    if (payload.pull_request) {
      return (payload.pull_request as any).base?.sha as string | undefined;
    }
    return undefined;
  }

  // ──────────────────────────────────────────────────────────────────
  //  Diff path orchestration
  // ──────────────────────────────────────────────────────────────────

  private async processDiffPath(
    prInfo: PrInfo,
    failedPayloads: string[],
    blockedFiles: BlockedFileResult[],
    userPsDeniedCache: Set<string>,
    userPsCache: Map<string, ApiResponse<ProtectionScopesResponse>>
  ): Promise<number> {
    this.logger.info(`Running diff flow for ${github.context.eventName} event`);

    const allCommits = await this.fileProcessor.getCommits();
    const commitShaSet = new Set(allCommits.map(c => c.sha));
    const lastProcessedSha = await this.findLastProcessedCommitSha(commitShaSet);
    const commitGroups = await this.fileProcessor.getFilesGroupedByCommit(lastProcessedSha, allCommits);

    if (commitGroups.length === 0) {
      this.logger.warn('No new commits to process');
      return 0;
    }

    const totalFiles = commitGroups.reduce((sum, cg) => sum + cg.files.length, 0);
    this.logger.info(`Diff flow: processing ${commitGroups.length} commit(s) with ${totalFiles} file(s) total`);

    const psRequest = this.payloadBuilder.buildProtectionScopesRequest();
    const requestLocation = psRequest.locations?.[0];
    if (!requestLocation) {
      this.logger.error('Protection scope request has no locations configured');
      throw new Error('Protection scope request has no locations configured');
    }

    const ctx: DiffPathContext = {
      prInfo, psRequest, requestLocation,
      failedPayloads, blockedFiles, userPsDeniedCache, userPsCache,
    };

    let diffFileCount = 0;
    for (const commitGroup of commitGroups) {
      diffFileCount += await this.processCommitGroup(commitGroup, ctx);
    }

    // Post blocked files notification (PR review comment or commit comment)
    if (blockedFiles.length > 0) {
      await this.postBlockedFilesNotification(prInfo, blockedFiles);
    }

    return diffFileCount;
  }

  private async processCommitGroup(commitGroup: CommitFiles, ctx: DiffPathContext): Promise<number> {
    const { sha, files } = commitGroup;
    this.logger.info(`── Processing commit ${sha} with ${files.length} file(s) ──`);

    if (files.length === 0) {
      this.logger.debug(`Commit ${sha} has no matching files, skipping`);
      return 0;
    }

    // Group files by userId
    const filesByUser = new Map<string, FileMetadata[]>();
    for (const file of files) {
      const userId = file.authorId || this.config.userId;
      const existing = filesByUser.get(userId) || [];
      existing.push(file);
      filesByUser.set(userId, existing);
    }

    this.logger.info(`Commit ${sha}: ${files.length} file(s) across ${filesByUser.size} user(s)`);

    for (const [userId, userFiles] of filesByUser) {
      await this.processUserFiles(userId, userFiles, ctx);
    }

    await this.sendCommitRequest(commitGroup, ctx);

    this.logger.debug(`Commit ${sha} processed successfully`);
    return files.length;
  }

  // ──────────────────────────────────────────────────────────────────
  //  Per-user file processing
  // ──────────────────────────────────────────────────────────────────

  private async processUserFiles(
    userId: string,
    userFiles: FileMetadata[],
    ctx: DiffPathContext
  ): Promise<void> {
    this.logger.debug(`Processing ${userFiles.length} file(s) for user ${userId}`);

    const psResult = await this.resolveUserPsWithCache(userId, ctx);
    if (!psResult) {
      await this.sendContentActivities(userFiles, ctx.prInfo, ctx.failedPayloads);
      return;
    }

    const { psResponse, scopeIdentifier } = psResult;

    // Check applicable scopes
    const scopeCheck = this.payloadBuilder.checkApplicableScopes(
      psResponse.value,
      Activity.uploadText,
      ctx.requestLocation
    );

    if (!scopeCheck.shouldProcess) {
      this.logger.debug(`No matching scopes for user ${userId}, routing ${userFiles.length} file(s) to contentActivities`);
      await this.sendContentActivities(userFiles, ctx.prInfo, ctx.failedPayloads);
      return;
    }

    if (scopeCheck.executionMode === ExecutionMode.evaluateInline) {
      await this.processFilesInline(userId, userFiles, scopeIdentifier, ctx);
    } else {
      await this.processFilesOffline(userId, userFiles, ctx);
    }
  }

  private async processFilesInline(
    userId: string,
    userFiles: FileMetadata[],
    scopeIdentifier: string,
    ctx: DiffPathContext
  ): Promise<void> {
    this.logger.debug(`evaluateInline: calling processContent for ${userFiles.length} file(s), user ${userId}`);

    const conversationId = crypto.randomUUID();
    let seqNum = 0;

    for (const file of userFiles) {
      const pcRequests = this.payloadBuilder.buildPerUserProcessContentRequest(file, conversationId, seqNum);
      seqNum += pcRequests.length;

      for (const pcRequest of pcRequests) {
        let pcResponse = await this.purviewClient.processContent(userId, pcRequest, scopeIdentifier, true);

        if (!pcResponse.success) {
          this.logger.error(`PC failed for file ${file.path}: ${pcResponse.error}. Falling back to contentActivities.`);
          ctx.failedPayloads.push(`pc-${file.path}`);
          await this.sendContentActivities([file], ctx.prInfo, ctx.failedPayloads);
          continue;
        }

        const pcData = pcResponse.data as ProcessContentResponse;

        // Handle protectionScopeState: "modified" → re-fetch scopes and retry
        if (pcData?.protectionScopeState === 'modified') {
          this.logger.info(`Protection scope state modified for user ${userId}, re-fetching scopes and retrying PC for ${file.path}`);

          const freshPsResponse = await this.purviewClient.searchUserProtectionScope(userId, ctx.psRequest);
          if (freshPsResponse.success && freshPsResponse.data) {
            ctx.userPsCache.set(userId, freshPsResponse);
            const freshScopeId = freshPsResponse.etag || '';
            pcResponse = await this.purviewClient.processContent(userId, pcRequest, freshScopeId, true);

            if (!pcResponse.success) {
              this.logger.error(`PC retry failed for file ${file.path}: ${pcResponse.error}`);
              ctx.failedPayloads.push(`pc-retry-${file.path}`);
              continue;
            }
          }
        }

        // Check for block actions
        const responseData = pcResponse.data as ProcessContentResponse;
        if (responseData && isBlocked(responseData)) {
          const blockingActions = getBlockingActions(responseData);
          this.logger.warn(`BLOCKED: File ${file.path} blocked by ${blockingActions.length} policy action(s)`);
          ctx.blockedFiles.push({
            filePath: file.path,
            userId,
            policyActions: blockingActions,
          });
        }
      }
    }
  }

  private async processFilesOffline(
    userId: string,
    userFiles: FileMetadata[],
    ctx: DiffPathContext
  ): Promise<void> {
    this.logger.debug(`evaluateOffline: sending ${userFiles.length} file(s) to PCA batch for user ${userId}`);
    const pcaBatchRequests = this.payloadBuilder.buildProcessContentBatchRequest(userFiles);
    for (const pcaBatchRequest of pcaBatchRequests) {
      const pcaResult = await this.purviewClient.processContentAsync(pcaBatchRequest);

      if (!pcaResult.success) {
        this.logger.error(`PCA batch failed for user ${userId}: ${pcaResult.error}. Falling back to contentActivities.`);
        ctx.failedPayloads.push(`pca-${userId}`);
        await this.sendContentActivities(userFiles, ctx.prInfo, ctx.failedPayloads);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  //  Shared PS resolution + commit-level + fallback helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * Resolve user protection scopes using the cache. Returns the PS response
   * and etag, or null if the caller should fall back to contentActivities.
   */
  private async resolveUserPsWithCache(
    userId: string,
    ctx: DiffPathContext
  ): Promise<{ psResponse: ProtectionScopesResponse; scopeIdentifier: string } | null> {
    if (ctx.userPsDeniedCache.has(userId)) {
      this.logger.warn(`Skipping user ${userId} — cached 401 from earlier PS call. Routing to contentActivities.`);
      return null;
    }

    let psApiResponse = ctx.userPsCache.get(userId);
    if (psApiResponse) {
      this.logger.debug(`Using cached PS response for user ${userId}`);
    } else {
      psApiResponse = await this.purviewClient.searchUserProtectionScope(userId, ctx.psRequest);
      if (psApiResponse.success) {
        ctx.userPsCache.set(userId, psApiResponse);
      }
    }

    if (!psApiResponse.success) {
      this.logger.error(`Failed to get protection scopes for user ${userId}: ${psApiResponse.error}`);
      ctx.failedPayloads.push(`ps-${userId}`);
      if (psApiResponse.statusCode === 401) {
        ctx.userPsDeniedCache.add(userId);
        this.logger.warn(`User ${userId} returned 401 on PS — cached, will skip in future calls.`);
      }
      return null;
    }

    const psResponse = psApiResponse.data;
    if (!psResponse || !psResponse.value) {
      this.logger.warn(`Empty protection scopes response for user ${userId}, routing to contentActivities`);
      return null;
    }

    return { psResponse, scopeIdentifier: psApiResponse.etag || '' };
  }

  /**
   * Send a commit-level request through the same routing as file requests.
   */
  private async sendCommitRequest(commitGroup: CommitFiles, ctx: DiffPathContext): Promise<void> {
    const commitUserId = commitGroup.authorId || this.config.userId;
    const commitIdentifier = `commit:${commitGroup.sha}`;
    this.logger.debug(`Sending commit-level request for ${commitIdentifier}, user ${commitUserId}`);

    const psResult = await this.resolveUserPsWithCache(commitUserId, ctx);
    if (!psResult) {
      await this.sendCommitContentActivity(commitGroup, ctx.prInfo, ctx.failedPayloads);
      return;
    }

    const scopeCheck = this.payloadBuilder.checkApplicableScopes(
      psResult.psResponse.value,
      Activity.uploadText,
      ctx.requestLocation
    );

    if (!scopeCheck.shouldProcess) {
      await this.sendCommitContentActivity(commitGroup, ctx.prInfo, ctx.failedPayloads);
      return;
    }

    if (scopeCheck.executionMode === ExecutionMode.evaluateInline) {
      const conversationId = crypto.randomUUID();
      const pcRequests = this.payloadBuilder.buildCommitProcessContentRequest(commitGroup, conversationId, 0);

      for (const pcRequest of pcRequests) {
        const pcResponse = await this.purviewClient.processContent(commitUserId, pcRequest, psResult.scopeIdentifier, true);

        if (!pcResponse.success) {
          this.logger.error(`PC failed for commit ${commitGroup.sha}: ${pcResponse.error}. Falling back to contentActivities.`);
          ctx.failedPayloads.push(`pc-commit-${commitGroup.sha}`);
          await this.sendCommitContentActivity(commitGroup, ctx.prInfo, ctx.failedPayloads);
          return;
        }

        const pcData = pcResponse.data as ProcessContentResponse;
        if (pcData && isBlocked(pcData)) {
          const blockingActions = getBlockingActions(pcData);
          this.logger.warn(`BLOCKED: Commit ${commitGroup.sha} blocked by ${blockingActions.length} policy action(s)`);
          ctx.blockedFiles.push({
            filePath: commitIdentifier,
            userId: commitUserId,
            policyActions: blockingActions,
          });
        }
      }
    } else {
      const pcaBatches = this.payloadBuilder.buildCommitProcessContentBatchRequest([commitGroup]);
      for (const pcaBatch of pcaBatches) {
        const pcaResult = await this.purviewClient.processContentAsync(pcaBatch);

        if (!pcaResult.success) {
          this.logger.error(`PCA failed for commit ${commitGroup.sha}: ${pcaResult.error}. Falling back to contentActivities.`);
          ctx.failedPayloads.push(`pca-commit-${commitGroup.sha}`);
          await this.sendCommitContentActivity(commitGroup, ctx.prInfo, ctx.failedPayloads);
          break;
        }
      }
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

  private async sendCommitContentActivity(commitGroup: CommitFiles, prInfo: PrInfo, failedPayloads: string[]): Promise<void> {
    const requests = this.payloadBuilder.buildCommitUploadSignalRequest(commitGroup, prInfo);
    for (const req of requests) {
      const result = await this.purviewClient.uploadSignal(req);
      if (!result.success) {
        this.logger.error(`ContentActivities upload failed for commit ${commitGroup.sha}: ${result.error}`);
        failedPayloads.push(`ca-commit-${commitGroup.sha}`);
      }
    }
  }

  /**
   * Post a notification about blocked files — PR review comment for pull_request
   * events, commit comment for push events.
   */
  private async postBlockedFilesNotification(_prInfo: PrInfo, blockedFiles: BlockedFileResult[]): Promise<void> {
    this.logger.info(`${blockedFiles.length} file(s) blocked, posting notification`);
    try {
      const githubToken = process.env['GITHUB_TOKEN'] || '';
      if (!githubToken) {
        this.logger.warn('Cannot post blocked files notification: missing GITHUB_TOKEN');
        return;
      }

      const octokit = github.getOctokit(githubToken);

      if (github.context.eventName === 'pull_request') {
        const prNumber = github.context.payload.pull_request?.number;
        if (prNumber) {
          const prCommentService = new PrCommentService(
            octokit,
            this.config.repository.owner,
            this.config.repository.repo,
            prNumber
          );
          await prCommentService.postBlockedFilesReview(blockedFiles);
        } else {
          this.logger.warn('Cannot post PR comment: PR number not available');
        }
      } else if (github.context.eventName === 'push') {
        const commitSha = github.context.sha;
        if (commitSha) {
          const body = this.formatBlockedFilesComment(blockedFiles);
          await octokit.rest.repos.createCommitComment({
            owner: this.config.repository.owner,
            repo: this.config.repository.repo,
            commit_sha: commitSha,
            body,
          });
          this.logger.info(`Commit comment posted on ${commitSha}`);
        } else {
          this.logger.warn('Cannot post commit comment: commit SHA not available');
        }
      } else {
        this.logger.info('Blocked files notification skipped (unsupported event type for comments)');
      }
    } catch (e) {
      this.logger.warn('Failed to post blocked files notification (non-fatal).', { error: e });
    }
  }

  private formatBlockedFilesComment(blockedFiles: BlockedFileResult[]): string {
    const lines: string[] = [
      '## ⚠️ Purview Data Security — Blocked Content Detected',
      '',
      'The following file(s) were flagged by data security policies and **blocked**:',
      '',
      '| File | Action |',
      '|------|--------|',
    ];

    for (const bf of blockedFiles) {
      for (const pa of bf.policyActions) {
        const action = pa.restrictionAction || pa.action;
        lines.push(`| \`${bf.filePath}\` | ${action} |`);
      }
    }

    lines.push('', '> This comment was generated by the Purview GitHub Action.');
    return lines.join('\n');
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
        [{ data: 'File', header: true }, { data: 'Action', header: true }],
        ...blocked.flatMap(bf =>
          bf.policyActions.map(pa => [
            bf.filePath,
            pa.restrictionAction || pa.action,
          ])
        ),
      ]);
    }
    
    await summary.write();
  }

  /**
   * Paginates through successful workflow runs in batches of 3, checking each
   * run's head_sha against the known PR commit SHAs. Returns the first match
   * (i.e. the most recent successfully processed commit), or null if none found.
   */
  private async findLastProcessedCommitSha(commitShas: Set<string>): Promise<string | null> {
    try {
      const githubToken = process.env['GITHUB_TOKEN'] || '';
      if (!githubToken) {
        this.logger.warn('GITHUB_TOKEN not available for workflow run history check');
        return null;
      }

      const octokit = github.getOctokit(githubToken);

      // Determine the workflow ID (just the filename, not the full path —
      // octokit URL-encodes slashes which causes 404 on the API)
      let workflowId = '';
      const workflowRef = process.env['GITHUB_WORKFLOW_REF'] || '';
      if (workflowRef) {
        const refMatch = workflowRef.match(/\.github\/workflows\/([^@]+)/);
        if (refMatch && refMatch[1]) {
          workflowId = refMatch[1];
        }
      }
      if (!workflowId && github.context.workflow) {
        workflowId = github.context.workflow;
      }
      if (!workflowId) {
        this.logger.warn('Could not determine workflow ID for commit dedup');
        return null;
      }

      // Resolve the numeric workflow ID from the current run — this is the most
      // reliable approach since the current run always knows its own workflow.
      const numericWorkflowId = await this.resolveWorkflowId(octokit);
      if (numericWorkflowId === null) {
        this.logger.info('Could not resolve workflow ID from current run — skipping commit dedup');
        return null;
      }

      // Scope to the current branch for more precise commit dedup
      let branch: string | undefined;
      if (github.context.eventName === 'pull_request') {
        branch = github.context.payload.pull_request?.['head']?.ref as string | undefined;
      } else if (github.context.eventName === 'push') {
        branch = github.context.ref?.replace('refs/heads/', '');
      }

      // Use listWorkflowRunsForRepo (not listWorkflowRuns) because in
      // cross-repo reusable-workflow setups the numeric workflow_id returned
      // by getWorkflowRun belongs to the *external* workflow-definition repo,
      // not the target repo.  listWorkflowRuns would 404 in that case.
      const perPage = 10;
      const maxRuns = 20;
      let page = 1;
      let totalFetched = 0;

      while (true) {
        const { data: runs } = await octokit.rest.actions.listWorkflowRunsForRepo({
          owner: this.config.repository.owner,
          repo: this.config.repository.repo,
          status: 'success' as any,
          ...(branch ? { branch } : {}),
          per_page: perPage,
          page,
        });

        if (runs.workflow_runs.length === 0) {
          break;
        }

        // Filter to only runs belonging to our workflow
        const matchingRuns = runs.workflow_runs.filter((r: any) => r.workflow_id === numericWorkflowId);

        for (const run of matchingRuns) {
          if (commitShas.has(run.head_sha)) {
            this.logger.info(`Found matching head SHA ${run.head_sha} from workflow run ${run.id} (page ${page})`);
            return run.head_sha;
          }
        }

        totalFetched += runs.workflow_runs.length;
        this.logger.info(`Checked ${totalFetched} run(s) so far (${matchingRuns.length} matched workflow), no match in commit list yet`);

        if (totalFetched >= runs.total_count || totalFetched >= maxRuns) {
          break;
        }

        page++;
      }

      this.logger.info('No previous successful run head SHA matches current commit list — will process all commits');
      return null;
    } catch (error: any) {
      if (error?.status === 404) {
        this.logger.warn(
          'Workflow run history returned 404. Ensure the workflow has "actions: read" permission ' +
          '(add `permissions: { actions: read }` to your workflow YAML). Proceeding without commit dedup.'
        );
      } else {
        this.logger.warn('Failed to query workflow run history for commit dedup', { error });
      }
      return null;
    }
  }

  /**
   * Resolves the numeric workflow ID by inspecting the current workflow run.
   */
  private async resolveWorkflowId(
    octokit: ReturnType<typeof github.getOctokit>
  ): Promise<number | null> {
    try {
      const runId = parseInt(this.config.repository.runId, 10);
      if (!runId) {
        this.logger.warn('No run ID available to resolve workflow ID');
        return null;
      }
      const { data: run } = await octokit.rest.actions.getWorkflowRun({
        owner: this.config.repository.owner,
        repo: this.config.repository.repo,
        run_id: runId,
      });
      const wfId = run.workflow_id;
      this.logger.info(`Resolved workflow ID ${wfId} from current run ${runId}`);
      return wfId;
    } catch (error) {
      this.logger.warn('Failed to resolve workflow ID from current run', { error });
      return null;
    }
  }
}