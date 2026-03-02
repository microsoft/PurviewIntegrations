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
exports.getConfig = getConfig;
const core = __importStar(require("@actions/core"));
function getConfig() {
    const includeGlobs = core.getInput('include-globs', { required: true }).split(/[\s,]+/).filter(Boolean);
    const excludeGlobs = core.getInput('exclude-globs', { required: false }).split(/[\s,]+/).filter(Boolean);
    const applicationHostCategories = core.getInput('application-host-categories', { required: false }).split(',').map(c => c.trim()).filter(Boolean);
    const maxFileBytes = parseInt(core.getInput('max-file-bytes', { required: true }), 10);
    if (isNaN(maxFileBytes) || maxFileBytes <= 0) {
        throw new Error('Input "max-file-bytes" must be a positive number.');
    }
    return {
        endpoint: core.getInput('endpoint', { required: true }),
        userPrincipalName: core.getInput('user-principal-name', { required: true }),
        tenantId: core.getInput('tenant-id', { required: true }),
        aadResource: core.getInput('aad-resource', { required: true }),
        includeGlobs: includeGlobs.length > 0 ? includeGlobs : ['**/*'],
        excludeGlobs,
        maxFileBytes,
        sliceLargeFiles: core.getBooleanInput('slice-large-files', { required: true }),
        skipBinary: core.getBooleanInput('skip-binary', { required: true }),
        includeSummaryPayload: core.getBooleanInput('include-summary-payload', { required: true }),
        minify: core.getBooleanInput('minify', { required: true }),
        failOnNon2xx: core.getBooleanInput('fail-on-non-2xx', { required: true }),
        appHostName: core.getInput('app-host-name', { required: true }),
        applicationHostCategories,
        debug: core.getBooleanInput('debug-logs', { required: true }),
    };
}
//# sourceMappingURL=config.js.map