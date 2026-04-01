import { ActionConfig, ApiResponse, ProcessContentBatchRequest, ProcessContentRequest, ProcessContentResponse, UploadSignalRequest, ProtectionScopesRequest, ProtectionScopesResponse, GraphUserInfoContainer } from '../config/types';
export declare class PurviewClient {
    private readonly config;
    private readonly logger;
    private readonly retryHandler;
    private authToken;
    private tokenProvider;
    private readonly baseUrl;
    constructor(config: ActionConfig);
    setAuthToken(token: string): void;
    /**
     * Set a callback that returns a fresh access token.  When set, the provider
     * is called before every request (it should cache internally) and again
     * after a 401 to attempt a single token-refresh retry.
     */
    setTokenProvider(provider: () => Promise<string>): void;
    private resolveAuthToken;
    processContentAsync(payload: ProcessContentBatchRequest): Promise<ApiResponse>;
    processContent(userId: string, request: ProcessContentRequest, scopeIdentifier: string, inline?: boolean): Promise<ApiResponse<ProcessContentResponse>>;
    uploadSignal(payload: UploadSignalRequest): Promise<ApiResponse>;
    searchTenantProtectionScope(payload: ProtectionScopesRequest): Promise<ApiResponse<ProtectionScopesResponse>>;
    searchUserProtectionScope(userId: string, payload: ProtectionScopesRequest): Promise<ApiResponse<ProtectionScopesResponse>>;
    getUserInfo(userEmails: string[]): Promise<ApiResponse<GraphUserInfoContainer>>;
    private sendRequest;
    private sendRequestInner;
    private jsonReplacer;
    private generateRequestId;
    private sanitizeEndpoint;
    private sanitizeErrorResponse;
}
//# sourceMappingURL=purviewClient.d.ts.map