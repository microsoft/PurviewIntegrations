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
exports.getScopedToken = getScopedToken;
const exec = __importStar(require("@actions/exec"));
async function getScopedToken(resource, tenantId, logger) {
    logger.info(`Attempting to acquire Azure AD token for resource: ${resource}`);
    const args = [
        'account',
        'get-access-token',
        '--resource',
        resource,
        '--tenant',
        tenantId,
        '--query',
        'accessToken',
        '-o',
        'tsv'
    ];
    let accessToken = '';
    let errorOutput = '';
    const options = {
        silent: true,
        listeners: {
            stdout: (data) => {
                accessToken += data.toString();
            },
            stderr: (data) => {
                errorOutput += data.toString();
            },
        },
    };
    try {
        const exitCode = await exec.exec('az', args, options);
        if (exitCode !== 0) {
            throw new Error(`az CLI exited with code ${exitCode}`);
        }
    }
    catch (error) {
        logger.error('Failed to execute `az account get-access-token`.');
        logger.error(`Error output: ${errorOutput}`);
        throw new Error('Azure token acquisition failed. Ensure you are logged in via `azure/login` with OIDC and the correct permissions are configured.');
    }
    const token = accessToken.trim();
    if (!token) {
        logger.error('`az account get-access-token` executed but returned an empty token.');
        logger.error(`Error output from az CLI: ${errorOutput}`);
        throw new Error('Acquired token is empty.');
    }
    logger.info('Successfully acquired Azure AD token.');
    return token;
}
//# sourceMappingURL=tokenProvider.js.map