"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubActionsRunner = void 0;
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const types_1 = require("../config/types");
const authenticationService_1 = require("../auth/authenticationService");
const fileProcessor_1 = require("../file/fileProcessor");
const purviewClient_1 = require("../api/purviewClient");
const payloadBuilder_1 = require("../payload/payloadBuilder");
const logger_1 = require("../utils/logger");
const blockDetector_1 = require("../utils/blockDetector");
const prCommentService_1 = require("../utils/prCommentService");
const fullScanService_1 = require("./fullScanService");
class GitHubActionsRunner {
    config;
    logger;
    authService;
    fileProcessor;
    purviewClient;
    payloadBuilder;
    fullScanService;
    constructor(config) {
        this.config = config;
        this.logger = new logger_1.Logger('GitHubActionsRunner');
        this.authService = new authenticationService_1.AuthenticationService(this.config);
        this.fileProcessor = new fileProcessor_1.FileProcessor(this.config);
        this.purviewClient = new purviewClient_1.PurviewClient(this.config);
        this.payloadBuilder = new payloadBuilder_1.PayloadBuilder(this.config);
        this.fullScanService = new fullScanService_1.FullScanService(this.config, this.fileProcessor, this.purviewClient, this.payloadBuilder);
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
            // ─── Full Scan Path (first run or manual workflow dispatch) ───
            let fullScanFileCount = 0;
            const isManualDispatch = github.context.eventName === 'workflow_dispatch';
            const shouldPerformFullScan = firstRun || isManualDispatch;
            if (shouldPerformFullScan) {
                if (isManualDispatch && !firstRun) {
                    this.logger.info('Performing full scan (manually triggered via workflow_dispatch)');
                }
                fullScanFileCount = await this.fullScanService.performFullScan(stateInfo, failedPayloads, prInfo, userPsDeniedCache);
            }
            // ─── PR Diff Path (skip if manually triggered) ───
            let diffFiles = [];
            if (!isManualDispatch) {
                // Step 4: Process PR diff files
                this.logger.info('Running PR diff flow');
                diffFiles = await this.fileProcessor.getLatestPushFiles();
                if (diffFiles.length === 0) {
                    this.logger.warn('No changed files found for PR diff');
                }
                else {
                    // Group files by userId
                    const filesByUser = new Map();
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
                        const scopeCheck = this.payloadBuilder.checkApplicableScopes(psResponse.value, types_1.Activity.uploadText, requestLocation);
                        if (!scopeCheck.shouldProcess) {
                            // No matching scopes → contentActivities (fire-and-forget)
                            this.logger.info(`No matching scopes for user ${userId}, routing ${userFiles.length} file(s) to contentActivities`);
                            await this.sendContentActivities(userFiles, prInfo, failedPayloads);
                            continue;
                        }
                        // Matching scopes found — route based on execution mode
                        if (scopeCheck.executionMode === types_1.ExecutionMode.evaluateInline) {
                            // evaluateInline → per-user PC, synchronous, parse for blocks
                            this.logger.info(`evaluateInline: calling processContent for ${userFiles.length} file(s), user ${userId}`);
                            const conversationId = crypto.randomUUID();
                            for (let i = 0; i < userFiles.length; i++) {
                                const file = userFiles[i];
                                const pcRequest = this.payloadBuilder.buildPerUserProcessContentRequest(file, conversationId, i);
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
                                if (responseData && (0, blockDetector_1.isBlocked)(responseData)) {
                                    const blockingActions = (0, blockDetector_1.getBlockingActions)(responseData);
                                    this.logger.warn(`BLOCKED: File ${file.path} blocked by ${blockingActions.length} policy action(s)`);
                                    blockedFiles.push({
                                        filePath: file.path,
                                        userId,
                                        policyActions: blockingActions,
                                    });
                                }
                            }
                        }
                        else {
                            // evaluateOffline → PCA batch (fire-and-forget)
                            this.logger.info(`evaluateOffline: sending ${userFiles.length} file(s) to PCA batch for user ${userId}`);
                            const pcaBatchRequest = this.payloadBuilder.buildProcessContentBatchRequest(userFiles);
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
                                const prCommentService = new prCommentService_1.PrCommentService(octokit, this.config.repository.owner, this.config.repository.repo, prNumber);
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
            const totalProcessed = fullScanFileCount + diffFiles.length;
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
}
exports.GitHubActionsRunner = GitHubActionsRunner;
//# sourceMappingURL=gitHubActionsRunner.js.map