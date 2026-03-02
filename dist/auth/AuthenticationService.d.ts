import { ActionConfig, AuthToken } from '../config/types';
export declare class AuthenticationService {
    private readonly config;
    private readonly logger;
    private readonly msalApp;
    private cachedToken;
    private readonly authMode;
    constructor(config: ActionConfig);
    getToken(): Promise<AuthToken>;
    private getClientAssertion;
    private isTokenValid;
    /**
     * Clear the cached token to force refresh on next request
     */
    clearCache(): void;
    private buildClientCertificateConfig;
    private extractPemBlock;
}
//# sourceMappingURL=authenticationService.d.ts.map