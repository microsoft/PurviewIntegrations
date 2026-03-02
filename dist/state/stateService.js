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
exports.StateService = void 0;
const github = __importStar(require("@actions/github"));
const logger_1 = require("../utils/logger");
class StateService {
    logger;
    constructor(logger) {
        this.logger = logger ?? new logger_1.Logger('StateService');
    }
    static defaultStatePathForTarget(targetOwner, targetRepo) {
        const safeOwner = targetOwner.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const safeRepo = targetRepo.replace(/[^a-zA-Z0-9_.-]/g, '_');
        return `.purview/state/${safeOwner}-${safeRepo}.json`;
    }
    async lookupStateFile(stateRepo, path) {
        const octokit = github.getOctokit(stateRepo.token);
        try {
            const { data } = await octokit.rest.repos.getContent({
                owner: stateRepo.owner,
                repo: stateRepo.repo,
                path,
                ref: stateRepo.branch,
            });
            if (Array.isArray(data) || !('sha' in data)) {
                return { exists: true };
            }
            return { exists: true, sha: data.sha };
        }
        catch (e) {
            // GitHub API returns 404 when the file doesn't exist.
            if (e?.status === 404) {
                return { exists: false };
            }
            throw e;
        }
    }
    async writeStateFile(stateRepo, path, state, message) {
        const octokit = github.getOctokit(stateRepo.token);
        const content = Buffer.from(JSON.stringify(state, null, 2), 'utf8').toString('base64');
        const lookup = await this.lookupStateFile(stateRepo, path);
        await octokit.rest.repos.createOrUpdateFileContents({
            owner: stateRepo.owner,
            repo: stateRepo.repo,
            path,
            message,
            content,
            branch: stateRepo.branch,
            sha: lookup.sha,
        });
        this.logger.info(`State marker written to ${stateRepo.owner}/${stateRepo.repo}:${path} (${stateRepo.branch})`);
    }
}
exports.StateService = StateService;
//# sourceMappingURL=stateService.js.map