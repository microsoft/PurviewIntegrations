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
exports.AuthenticationService = void 0;
const core = __importStar(require("@actions/core"));
const msal_node_1 = require("@azure/msal-node");
const crypto_1 = require("crypto");
const logger_1 = require("../utils/logger");
class AuthenticationService {
    config;
    logger;
    msalApp;
    cachedToken = null;
    authMode;
    constructor(config) {
        this.config = config;
        this.logger = new logger_1.Logger('AuthenticationService');
        const authority = `https://login.microsoftonline.com/${this.config.tenantId}`;
        const clientCertificatePem = this.config.clientCertificatePem?.trim();
        if (clientCertificatePem) {
            const clientCertificate = this.buildClientCertificateConfig(clientCertificatePem);
            this.authMode = 'certificate';
            this.logger.info('Authentication mode: certificate');
            this.msalApp = new msal_node_1.ConfidentialClientApplication({
                auth: {
                    clientId: this.config.clientId,
                    authority,
                    clientCertificate
                }
            });
        }
        else {
            this.authMode = 'federated';
            this.logger.info('Authentication mode: federated (GitHub OIDC)');
            // Initialize MSAL application with federated credential configuration
            this.msalApp = new msal_node_1.ConfidentialClientApplication({
                auth: {
                    clientId: this.config.clientId,
                    authority,
                    clientAssertion: this.getClientAssertion.bind(this)
                }
            });
        }
    }
    async getToken() {
        try {
            // Check cached token
            if (this.cachedToken && this.isTokenValid(this.cachedToken)) {
                this.logger.debug('Using cached token');
                return this.cachedToken;
            }
            this.logger.info(`Acquiring new token using MSAL (${this.authMode})`);
            let scope = URL.parse(this.config.purviewEndpoint)?.host ?? "graph.microsoft.com";
            // Configure client credential request
            const clientCredentialRequest = {
                scopes: [`https://${scope}/.default`],
            };
            // Acquire token using client credentials flow with federated credential
            const response = await this.msalApp.acquireTokenByClientCredential(clientCredentialRequest);
            if (!response || !response.accessToken) {
                throw new Error('Failed to acquire token from MSAL');
            }
            // Create AuthToken from MSAL response
            const authToken = {
                accessToken: response.accessToken,
                expiresAt: response.expiresOn || new Date(Date.now() + 3600000) // fallback to 1 hour
            };
            // Cache the token
            this.cachedToken = authToken;
            this.logger.info('Token acquired successfully using MSAL');
            return authToken;
        }
        catch (error) {
            this.logger.error('Authentication failed', { error });
            throw new Error(`Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    async getClientAssertion() {
        try {
            if (this.authMode !== 'federated') {
                throw new Error('Client assertion requested while not in federated auth mode');
            }
            // Get GitHub OIDC token to use as federated credential
            this.logger.debug('Acquiring GitHub OIDC token for federated credential');
            const audience = "api://AzureADTokenExchange";
            const oidcToken = await core.getIDToken(audience);
            if (!oidcToken) {
                throw new Error('Failed to get OIDC token from GitHub Actions');
            }
            this.logger.debug('GitHub OIDC token acquired successfully');
            return oidcToken;
        }
        catch (error) {
            this.logger.error('Failed to get client assertion', { error });
            throw new Error(`Failed to get federated credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    isTokenValid(token) {
        const bufferMinutes = 5;
        const expiryWithBuffer = new Date(token.expiresAt.getTime() - (bufferMinutes * 60 * 1000));
        return new Date() < expiryWithBuffer;
    }
    /**
     * Clear the cached token to force refresh on next request
     */
    clearCache() {
        this.cachedToken = null;
        this.logger.debug('Token cache cleared');
    }
    buildClientCertificateConfig(pem) {
        const privateKey = this.extractPemBlock(pem, /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/m, 'PRIVATE KEY');
        const certificate = this.extractPemBlock(pem, /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/m, 'CERTIFICATE');
        const x509 = new crypto_1.X509Certificate(certificate);
        const thumbprint = (0, crypto_1.createHash)('sha1').update(x509.raw).digest('hex').toUpperCase();
        return {
            thumbprint,
            privateKey
        };
    }
    extractPemBlock(pem, pattern, label) {
        const match = pem.match(pattern);
        if (!match || !match[0]) {
            throw new Error(`client-certificate is missing a ${label} PEM block`);
        }
        return match[0].trim();
    }
}
exports.AuthenticationService = AuthenticationService;
//# sourceMappingURL=authenticationService.js.map