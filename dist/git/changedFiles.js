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
exports.getChangedFiles = getChangedFiles;
const glob = __importStar(require("@actions/glob"));
async function getChangedFiles(config, logger) {
    const changedFilesEnv = process.env.CHANGED_FILES;
    const patterns = [...config.includeGlobs, ...config.excludeGlobs.map(p => `!${p}`)];
    const globber = await glob.create(patterns.join('\n'));
    const allFilesMatchingGlobs = await globber.glob(); // This now correctly takes 0 arguments
    if (!changedFilesEnv) {
        logger.warn('CHANGED_FILES environment variable not set. This is expected for push events to a default branch or manual runs. Scanning all files matching globs.');
        logger.info(`Found ${allFilesMatchingGlobs.length} files matching glob patterns in the repository.`);
        return allFilesMatchingGlobs;
    }
    const changedFilesList = new Set(changedFilesEnv.split(' ').filter(Boolean));
    logger.debug(`Received ${changedFilesList.size} changed files from environment variable.`);
    // Find the intersection between all files matching the glob and the files that actually changed.
    const filteredFiles = allFilesMatchingGlobs.filter(file => changedFilesList.has(file));
    logger.info(`Found ${filteredFiles.length} changed files that match the include/exclude glob patterns.`);
    if (config.debug) {
        logger.debug(`Final list of files to process: \n${filteredFiles.join('\n')}`);
    }
    return filteredFiles;
}
//# sourceMappingURL=changedFiles.js.map