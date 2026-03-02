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
exports.validateInputs = validateInputs;
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const logger_1 = require("../utils/logger");
const workflowRepo_1 = require("../utils/workflowRepo");
async function validateInputs() {
    const logger = new logger_1.Logger('InputValidator');
    try {
        // Get and validate required inputs
        const clientId = core.getInput('client-id', { required: true });
        const clientCertificatePemRaw = core.getInput('client-certificate', { required: false });
        const tenantId = core.getInput('tenant-id', { required: true });
        const purviewAccountName = core.getInput('purview-account-name');
        var purviewEndpoint = core.getInput('purview-endpoint');
        const usersJsonPath = core.getInput('users-json-path') || 'users.json';
        // Read state-repo-token early — it doubles as the credential for fetching
        // users.json from the workflow-definition repo via the GitHub API.
        const stateRepoBranch = (core.getInput('state-repo-branch') || '').trim();
        const stateRepoToken = (core.getInput('state-repo-token') || '').trim();
        // --------------- Load users.json ---------------
        // The file is expected to live in the workflow-definition repo (e.g.
        // PurviewWorkflow), NOT the target repo being scanned. When the workflow
        // repo differs from the target repo and a state-repo-token is available,
        // the file is fetched via the GitHub API; otherwise we fall back to the
        // local filesystem ($GITHUB_WORKSPACE).
        let userId;
        let userMappings;
        const workflowRepo = (0, workflowRepo_1.tryParseWorkflowRepoFromEnv)();
        const { context } = github;
        const targetRepoFullName = `${context.repo.owner}/${context.repo.repo}`.toLowerCase();
        const workflowRepoFullName = workflowRepo
            ? `${workflowRepo.owner}/${workflowRepo.repo}`.toLowerCase()
            : '';
        const isExternalWorkflowRepo = !!workflowRepo && workflowRepoFullName !== targetRepoFullName;
        // Debug: log workflow repo resolution details
        logger.info(`GITHUB_WORKFLOW_REF = '${process.env['GITHUB_WORKFLOW_REF'] || ''}'`);
        logger.info(`Parsed workflowRepo = ${workflowRepo ? JSON.stringify(workflowRepo) : 'undefined'}`);
        logger.info(`Target repo = '${targetRepoFullName}', Workflow repo = '${workflowRepoFullName}'`);
        logger.info(`isExternalWorkflowRepo = ${isExternalWorkflowRepo}`);
        logger.info(`stateRepoToken present = ${!!stateRepoToken}`);
        let parsed;
        // Determine the best token for fetching users.json from the workflow repo.
        // Prefer state-repo-token, fall back to GITHUB_TOKEN (works for public repos
        // or when the token has cross-repo access via org rulesets).
        const apiTokenForUsersJson = stateRepoToken || process.env['GITHUB_TOKEN'] || '';
        if (isExternalWorkflowRepo && apiTokenForUsersJson) {
            // Fetch users.json from the workflow-definition repo via the GitHub API
            logger.info(`Fetching users.json from workflow-definition repo ${workflowRepo.owner}/${workflowRepo.repo}`);
            const octokit = github.getOctokit(apiTokenForUsersJson);
            try {
                const { data } = await octokit.rest.repos.getContent({
                    owner: workflowRepo.owner,
                    repo: workflowRepo.repo,
                    path: usersJsonPath,
                    ...(workflowRepo.ref ? { ref: workflowRepo.ref } : {}),
                });
                if (Array.isArray(data) || !('content' in data)) {
                    throw new Error(`${usersJsonPath} in ${workflowRepo.owner}/${workflowRepo.repo} is not a file.`);
                }
                const content = Buffer.from(data.content, 'base64').toString('utf-8');
                parsed = JSON.parse(content);
                logger.info(`Loaded users.json from ${workflowRepo.owner}/${workflowRepo.repo}/${usersJsonPath}`);
            }
            catch (e) {
                if (e?.status === 404) {
                    throw new Error(`users.json not found at '${usersJsonPath}' in ${workflowRepo.owner}/${workflowRepo.repo}. ` +
                        'Create a users.json in your workflow-definition repo with email-to-userId mappings and a defaultUserId.');
                }
                throw e;
            }
        }
        else {
            // Local filesystem fallback (same-repo workflow or no token)
            const fs = await Promise.resolve().then(() => __importStar(require('fs')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            const absPath = path.default.isAbsolute(usersJsonPath)
                ? usersJsonPath
                : path.default.join(process.env['GITHUB_WORKSPACE'] || process.cwd(), usersJsonPath);
            if (!fs.default.existsSync(absPath)) {
                throw new Error(`users.json not found at ${absPath}. ` +
                    'Create a users.json in your workflow-definition repo with email-to-userId mappings and a defaultUserId.');
            }
            parsed = JSON.parse(fs.default.readFileSync(absPath, 'utf-8'));
            logger.info(`Loaded users.json from filesystem: ${absPath}`);
        }
        if (!parsed.defaultUserId) {
            throw new Error('users.json must contain a "defaultUserId" field.');
        }
        if (!Array.isArray(parsed.users)) {
            throw new Error('users.json must contain a "users" array.');
        }
        userMappings = parsed.users;
        userId = parsed.defaultUserId;
        logger.info(`Loaded ${userMappings.length} user mapping(s)`);
        logger.info(`Default userId from users.json: ${userId}`);
        // Validate format
        if (!isValidGuid(clientId)) {
            throw new Error('Invalid client-id format. Expected GUID.');
        }
        if (!isValidGuid(tenantId)) {
            throw new Error('Invalid tenant-id format. Expected GUID.');
        }
        if (!isValidUrl(purviewEndpoint)) {
            purviewEndpoint = `https://graph.microsoft.com/v1.0`;
        }
        const clientCertificatePem = clientCertificatePemRaw?.trim() ? clientCertificatePemRaw.trim() : undefined;
        if (clientCertificatePem) {
            validateClientCertificatePem(clientCertificatePem);
        }
        // Get optional inputs
        const filePatterns = core.getInput('file-patterns') || '*.md,*.json,*.yml,*.yaml';
        const excludePatternsRaw = core.getInput('exclude-patterns') || '';
        const maxFileSize = parseInt(core.getInput('max-file-size') || '10485760', 10);
        const debug = core.getBooleanInput('debug');
        // (stateRepoBranch and stateRepoToken were read earlier, before users.json loading)
        // Validate optional inputs
        if (isNaN(maxFileSize) || maxFileSize <= 0) {
            throw new Error('Invalid max-file-size. Must be a positive number.');
        }
        // Get repository context (context already destructured above for workflow-repo detection)
        const repository = {
            owner: context.repo.owner,
            repo: context.repo.repo,
            branch: context.ref.replace('refs/heads/', ''),
            sha: context.sha,
            runId: context.runId.toString(),
            runNumber: context.runNumber.toString()
        };
        // State tracking is only supported via an explicit token (writes to the workflow-definition repo).
        const hasStateRepoToken = stateRepoToken.length > 0;
        if (!hasStateRepoToken && stateRepoBranch.length > 0) {
            throw new Error('state-repo-branch is only supported when state-repo-token is provided.');
        }
        const config = {
            clientId,
            clientCertificatePem,
            tenantId,
            purviewAccountName,
            purviewEndpoint,
            filePatterns: filePatterns.split(',').map(p => p.trim()).filter(Boolean),
            excludePatterns: excludePatternsRaw.split(',').map(p => p.trim()).filter(Boolean),
            maxFileSize,
            debug,
            repository,
            userId,
            userMappings,
            stateRepoBranch,
            stateRepoToken
        };
        logger.debug('Configuration validated', {
            patterns: config.filePatterns.length,
            maxSize: config.maxFileSize
        });
        return config;
    }
    catch (error) {
        logger.error('Input validation failed', { error });
        throw error;
    }
}
function isValidGuid(guid) {
    const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return guidRegex.test(guid);
}
function isValidUrl(url) {
    try {
        new URL(url);
        return true;
    }
    catch {
        return false;
    }
}
function validateClientCertificatePem(pem) {
    // Minimal validation: must contain at least one cert and one private key block.
    const hasCert = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/m.test(pem);
    const hasPrivateKey = /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/m.test(pem);
    if (!hasCert || !hasPrivateKey) {
        throw new Error('Invalid client-certificate. Expected a PEM containing both a CERTIFICATE block and a PRIVATE KEY block.');
    }
}
//# sourceMappingURL=inputValidator.js.map