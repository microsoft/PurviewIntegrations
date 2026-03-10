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
exports.FullScanService = void 0;
const github = __importStar(require("@actions/github"));
const logger_1 = require("../utils/logger");
const stateService_1 = require("../state/stateService");
const workflowRepo_1 = require("../utils/workflowRepo");
class FullScanService {
    config;
    fileProcessor;
    purviewClient;
    payloadBuilder;
    logger;
    stateService;
    constructor(config, fileProcessor, purviewClient, payloadBuilder) {
        this.config = config;
        this.fileProcessor = fileProcessor;
        this.purviewClient = purviewClient;
        this.payloadBuilder = payloadBuilder;
        this.logger = new logger_1.Logger('FullScanService');
        this.stateService = new stateService_1.StateService(this.logger);
    }
    /**
     * Sets up state tracking configuration and determines if this is the first run
     */
    async setupStateTrackingAndDetectFirstRun() {
        const targetOwner = this.config.repository.owner;
        const targetRepo = this.config.repository.repo;
        const stateTrackingTokenPresent = !!(this.config.stateRepoToken && this.config.stateRepoToken.length > 0);
        const statePath = stateService_1.StateService.defaultStatePathForTarget(targetOwner, targetRepo);
        const workflowRepo = (0, workflowRepo_1.tryParseWorkflowRepoFromEnv)();
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
        const firstRun = await this.detectFirstRun(stateTrackingEffective, stateRepoToken, stateRepoOwner, stateRepoName, stateRepoBranch, statePath, targetOwner, targetRepo);
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
    async performFullScan(stateInfo, failedPayloads, prInfo, userPsDeniedCache) {
        this.logger.info(stateInfo
            ? 'First run detected; scanning full repository.'
            : 'State tracking disabled; scanning full repository.');
        const allFiles = await this.fileProcessor.getAllRepoFiles();
        const fullScanFileCount = allFiles.length;
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
        }
        else if (!tenantPsResponse.data?.value || tenantPsResponse.data.value.length === 0) {
            // Tenant PS has no scopes → contentActivities for ALL files
            this.logger.warn('Tenant PS returned no protection scopes. Falling back to contentActivities for all files.');
            await this.sendContentActivities(allFiles, prInfo, failedPayloads);
        }
        else {
            // Tenant PS has scopes → group files by user and call per-user PS + PCA
            this.logger.info(`Tenant PS returned ${tenantPsResponse.data.value.length} scope(s). Grouping files by user for per-user PS + PCA.`);
            await this.processFilesByUser(allFiles, prInfo, failedPayloads, psRequest, userPsDeniedCache);
        }
        // Write state marker
        if (stateInfo) {
            await this.writeStateMarker(stateInfo);
        }
        return fullScanFileCount;
    }
    async resolveDefaultBranch(token, owner, repo) {
        try {
            const octokit = github.getOctokit(token);
            const { data } = await octokit.rest.repos.get({ owner, repo });
            this.logger.info(`Resolved workflow repo default branch as ${data.default_branch}`);
            return data.default_branch;
        }
        catch (e) {
            this.logger.warn('Failed to resolve workflow repo default branch; state tracking disabled.', { error: e });
            return '';
        }
    }
    async ensureBranchExists(token, owner, repo, branch) {
        try {
            const octokit = github.getOctokit(token);
            try {
                await octokit.rest.repos.getBranch({ owner, repo, branch });
                this.logger.info(`State repo branch '${branch}' exists.`);
            }
            catch (branchErr) {
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
                }
                else {
                    throw branchErr;
                }
            }
        }
        catch (e) {
            this.logger.warn(`Failed to verify/create state repo branch '${branch}'; state tracking may fail.`, { error: e });
        }
    }
    async detectFirstRun(stateTrackingEffective, stateRepoToken, stateRepoOwner, stateRepoName, stateRepoBranch, statePath, targetOwner, targetRepo) {
        if (stateTrackingEffective) {
            const lookup = await this.stateService.lookupStateFile({
                owner: stateRepoOwner,
                repo: stateRepoName,
                branch: stateRepoBranch,
                token: stateRepoToken,
            }, statePath);
            return !lookup.exists;
        }
        else {
            // State tracking not enabled - check workflow history to determine if this is first run
            return await this.detectFirstRunFromWorkflowHistory(targetOwner, targetRepo);
        }
    }
    async detectFirstRunFromWorkflowHistory(targetOwner, targetRepo) {
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
                const refMatch = workflowRef.match(/\.github\/workflows\/[^@]+/);
                if (refMatch) {
                    workflowId = refMatch[0];
                    this.logger.info(`Extracted workflow file path from GITHUB_WORKFLOW_REF: ${workflowId}`);
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
            const { data: workflowRuns } = await octokit.rest.actions.listWorkflowRuns({
                owner: targetOwner,
                repo: targetRepo,
                workflow_id: workflowId,
                status: 'completed',
                conclusion: 'success',
                per_page: 1,
            });
            // If there are no completed runs, this is the first run
            const firstRun = workflowRuns.total_count === 0;
            this.logger.info(firstRun
                ? 'First workflow run detected based on workflow history'
                : `Previous workflow runs found (${workflowRuns.total_count} completed runs), not first run`);
            return firstRun;
        }
        catch (error) {
            this.logger.warn('Failed to check workflow history, defaulting to non-first run', { error });
            return false;
        }
    }
    async processFilesByUser(allFiles, prInfo, failedPayloads, psRequest, userPsDeniedCache) {
        const filesByUser = new Map();
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
            const pcaBatchRequest = this.payloadBuilder.buildProcessContentBatchRequest(userFiles);
            this.logger.info(`Full scan: sending ${userFiles.length} file(s) to PCA batch for user ${userId}`);
            const pcaResult = await this.purviewClient.processContentAsync(pcaBatchRequest);
            if (!pcaResult.success) {
                this.logger.error(`PCA batch failed for user ${userId}: ${pcaResult.error}. Falling back to contentActivities.`);
                failedPayloads.push(`pca-fullscan-${userId}`);
                await this.sendContentActivities(userFiles, prInfo, failedPayloads);
            }
            else {
                this.logger.info(`Full scan PCA batch completed for user ${userId}`);
            }
        }
    }
    async writeStateMarker(stateInfo) {
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
        }
        catch (e) {
            this.logger.warn('Failed to write state marker file (non-fatal).', { error: e });
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
}
exports.FullScanService = FullScanService;
//# sourceMappingURL=fullScanService.js.map