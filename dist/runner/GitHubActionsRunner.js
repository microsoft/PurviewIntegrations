import * as core from '@actions/core';
import * as github from '@actions/github';
import { ExecutionMode, Activity } from '../config/types';
import { AuthenticationService } from '../auth/authenticationService';
import { FileProcessor } from '../file/fileProcessor';
import { PurviewClient } from '../api/purviewClient';
import { PayloadBuilder } from '../payload/payloadBuilder';
import { Logger } from '../utils/logger';
import { isBlocked, getBlockingActions } from '../utils/blockDetector';
import { PrCommentService } from '../utils/prCommentService';
import { FullScanService } from './fullScanService';
export class GitHubActionsRunner {
    config;
    logger;
    authService;
    fileProcessor;
    purviewClient;
    payloadBuilder;
    fullScanService;
    constructor(config) {
        this.config = config;
        this.logger = new Logger('GitHubActionsRunner');
        this.authService = new AuthenticationService(this.config);
        this.fileProcessor = new FileProcessor(this.config);
        this.purviewClient = new PurviewClient(this.config);
        this.payloadBuilder = new PayloadBuilder(this.config);
        this.fullScanService = new FullScanService(this.config, this.fileProcessor, this.purviewClient, this.payloadBuilder);
    }
    async execute() {
        try {
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
            const failedPayloads = [];
            const blockedFiles = [];
            // Cache of userIds that returned 401 on User PS — skip them on subsequent calls
            const userPsDeniedCache = new Set();
            // Cache of successful User PS responses — avoids redundant API calls for the same user across commits
            const userPsCache = new Map();
            // ─── Full Scan Path (first run or manual workflow dispatch) ───
            let fullScanFileCount = 0;
            const isManualDispatch = github.context.eventName === 'workflow_dispatch';
            const shouldPerformFullScan = firstRun || isManualDispatch;
            if (shouldPerformFullScan) {
                if (isManualDispatch && !firstRun) {
                    this.logger.info('Performing full scan (manually triggered via workflow_dispatch)');
                }
                fullScanFileCount = await this.fullScanService.performFullScan(stateInfo, failedPayloads, prInfo, userPsDeniedCache, userPsCache);
            }
            // ─── PR Diff Path (skip if manually triggered) ───
            let diffFileCount = 0;
            if (!isManualDispatch) {
                // Step 4: Process commits
                this.logger.info('Running PR diff flow');
                // Get the commit list, then find the last processed position via workflow run history
                const allCommits = await this.fileProcessor.getCommits();
                const commitShaSet = new Set(allCommits.map(c => c.sha));
                const lastProcessedSha = await this.findLastProcessedCommitSha(commitShaSet);
                // Get files grouped by commit, skipping already-processed commits
                const commitGroups = await this.fileProcessor.getFilesGroupedByCommit(lastProcessedSha);
                if (commitGroups.length === 0) {
                    this.logger.warn('No new commits to process for PR diff');
                }
                else {
                    for (const commitGroup of commitGroups) {
                        const { sha, files } = commitGroup;
                        this.logger.info(`── Processing commit ${sha} with ${files.length} file(s) ──`);
                        if (files.length === 0) {
                            this.logger.info(`Commit ${sha} has no matching files, skipping`);
                            continue;
                        }
                        diffFileCount += files.length;
                        // Group files by userId
                        const filesByUser = new Map();
                        for (const file of files) {
                            const userId = file.authorId || this.config.userId;
                            const existing = filesByUser.get(userId) || [];
                            existing.push(file);
                            filesByUser.set(userId, existing);
                        }
                        this.logger.info(`Commit ${sha}: ${files.length} file(s) across ${filesByUser.size} user(s)`);
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
                            // Call per-user protection scopes (check cache first)
                            let psApiResponse = userPsCache.get(userId);
                            if (psApiResponse) {
                                this.logger.info(`Using cached PS response for user ${userId}`);
                            }
                            else {
                                psApiResponse = await this.purviewClient.searchUserProtectionScope(userId, psRequest);
                                if (psApiResponse.success) {
                                    userPsCache.set(userId, psApiResponse);
                                }
                            }
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
                            const scopeCheck = this.payloadBuilder.checkApplicableScopes(psResponse.value, Activity.uploadText, requestLocation);
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
                                let seqNum = 0;
                                for (const file of userFiles) {
                                    const pcRequests = this.payloadBuilder.buildPerUserProcessContentRequest(file, conversationId, seqNum);
                                    seqNum += pcRequests.length;
                                    for (const pcRequest of pcRequests) {
                                        let pcResponse = await this.purviewClient.processContent(userId, pcRequest, scopeIdentifier, true);
                                        if (!pcResponse.success) {
                                            this.logger.error(`PC failed for file ${file.path}: ${pcResponse.error}. Falling back to contentActivities.`);
                                            failedPayloads.push(`pc-${file.path}`);
                                            await this.sendContentActivities([file], prInfo, failedPayloads);
                                            continue;
                                        }
                                        const pcData = pcResponse.data;
                                        // Handle protectionScopeState: "modified" → re-fetch scopes and retry
                                        if (pcData?.protectionScopeState === 'modified') {
                                            this.logger.info(`Protection scope state modified for user ${userId}, re-fetching scopes and retrying PC for ${file.path}`);
                                            const freshPsResponse = await this.purviewClient.searchUserProtectionScope(userId, psRequest);
                                            if (freshPsResponse.success && freshPsResponse.data) {
                                                userPsCache.set(userId, freshPsResponse);
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
                                        const responseData = pcResponse.data;
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
                                }
                            }
                            else {
                                // evaluateOffline → PCA batch (fire-and-forget)
                                this.logger.info(`evaluateOffline: sending ${userFiles.length} file(s) to PCA batch for user ${userId}`);
                                const pcaBatchRequests = this.payloadBuilder.buildProcessContentBatchRequest(userFiles);
                                for (const pcaBatchRequest of pcaBatchRequests) {
                                    const pcaResult = await this.purviewClient.processContentAsync(pcaBatchRequest);
                                    if (!pcaResult.success) {
                                        this.logger.error(`PCA batch failed for user ${userId}: ${pcaResult.error}. Falling back to contentActivities.`);
                                        failedPayloads.push(`pca-${userId}`);
                                        await this.sendContentActivities(userFiles, prInfo, failedPayloads);
                                    }
                                }
                            }
                        }
                        this.logger.info(`Commit ${sha} processed successfully`);
                    }
                    // Post PR review comment if any files were blocked
                    if (blockedFiles.length > 0 && prInfo.url) {
                        this.logger.info(`${blockedFiles.length} file(s) blocked, posting PR review comment`);
                        try {
                            const githubToken = process.env['GITHUB_TOKEN'] || '';
                            const prNumber = parseInt(prInfo.url?.split('/').pop() || '0', 10);
                            if (githubToken && prNumber > 0) {
                                const octokit = github.getOctokit(githubToken);
                                const prCommentService = new PrCommentService(octokit, this.config.repository.owner, this.config.repository.repo, prNumber);
                                await prCommentService.postBlockedFilesReview(blockedFiles);
                            }
                            else {
                                this.logger.warn('Cannot post PR comment: missing GITHUB_TOKEN or PR number');
                            }
                        }
                        catch (e) {
                            this.logger.warn('Failed to post PR review comment (non-fatal).', { error: e });
                        }
                    }
                }
            }
            else {
                this.logger.info('Skipping PR diff processing (manually triggered workflow)');
            }
            // Step 5: Set outputs
            const totalProcessed = fullScanFileCount + diffFileCount;
            core.setOutput('processed-files', totalProcessed);
            core.setOutput('failed-requests', failedPayloads.length);
            core.setOutput('blocked-files', JSON.stringify(blockedFiles.map(bf => bf.filePath)));
            // Step 6: Summary
            await this.createSummary(totalProcessed, failedPayloads, blockedFiles);
            // Step 7: Fail the action if any files were blocked
            if (blockedFiles.length > 0) {
                const blockedFilePaths = blockedFiles.map(bf => bf.filePath).join(', ');
                const message = `Action failed: ${blockedFiles.length} file(s) were blocked by data security policies: ${blockedFilePaths}`;
                this.logger.error(message);
                core.setFailed(message);
                return;
            }
        }
        catch (error) {
            this.logger.error('Execution failed', { error });
            throw error;
        }
    }
    async sendContentActivities(files, prInfo, failedPayloads) {
        const uploadRequests = this.payloadBuilder.buildUploadSignalRequest(files, prInfo);
        for (const req of uploadRequests) {
            const result = await this.purviewClient.uploadSignal(req);
            if (!result.success) {
                this.logger.error(`ContentActivities upload failed for ${req.contentMetadata.contentEntries[0]?.identifier}: ${result.error}`);
                failedPayloads.push(req.id);
            }
        }
    }
    async createSummary(processed, failed, blocked = []) {
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
                ...blocked.flatMap(bf => bf.policyActions.map(pa => [
                    bf.filePath,
                    pa.policyName || pa.policyId || 'Unknown',
                    pa.restrictionAction || pa.action,
                ])),
            ]);
        }
        await summary.write();
    }
    /**
     * Paginates through successful workflow runs in batches of 3, checking each
     * run's head_sha against the known PR commit SHAs. Returns the first match
     * (i.e. the most recent successfully processed commit), or null if none found.
     */
    async findLastProcessedCommitSha(commitShas) {
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
            // Scope to the PR head branch if available
            const branch = github.context.payload.pull_request?.['head']?.ref;
            // Use listWorkflowRunsForRepo (not listWorkflowRuns) because in
            // cross-repo reusable-workflow setups the numeric workflow_id returned
            // by getWorkflowRun belongs to the *external* workflow-definition repo,
            // not the target repo.  listWorkflowRuns would 404 in that case.
            const perPage = 10;
            let page = 1;
            let totalFetched = 0;
            while (true) {
                const { data: runs } = await octokit.rest.actions.listWorkflowRunsForRepo({
                    owner: this.config.repository.owner,
                    repo: this.config.repository.repo,
                    status: 'success',
                    ...(branch ? { branch } : {}),
                    per_page: perPage,
                    page,
                });
                if (runs.workflow_runs.length === 0) {
                    break;
                }
                // Filter to only runs belonging to our workflow
                const matchingRuns = runs.workflow_runs.filter((r) => r.workflow_id === numericWorkflowId);
                for (const run of matchingRuns) {
                    if (commitShas.has(run.head_sha)) {
                        this.logger.info(`Found matching head SHA ${run.head_sha} from workflow run ${run.id} (page ${page})`);
                        return run.head_sha;
                    }
                }
                totalFetched += runs.workflow_runs.length;
                this.logger.info(`Checked ${totalFetched} run(s) so far (${matchingRuns.length} matched workflow), no match in commit list yet`);
                if (totalFetched >= runs.total_count) {
                    break;
                }
                page++;
            }
            this.logger.info('No previous successful run head SHA matches current commit list — will process all commits');
            return null;
        }
        catch (error) {
            if (error?.status === 404) {
                this.logger.warn('Workflow run history returned 404. Ensure the workflow has "actions: read" permission ' +
                    '(add `permissions: { actions: read }` to your workflow YAML). Proceeding without commit dedup.');
            }
            else {
                this.logger.warn('Failed to query workflow run history for commit dedup', { error });
            }
            return null;
        }
    }
    /**
     * Resolves the numeric workflow ID by inspecting the current workflow run.
     */
    async resolveWorkflowId(octokit) {
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
        }
        catch (error) {
            this.logger.warn('Failed to resolve workflow ID from current run', { error });
            return null;
        }
    }
}
//# sourceMappingURL=gitHubActionsRunner.js.map