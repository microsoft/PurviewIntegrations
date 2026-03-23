import { ActionConfig, PurviewPayload, ApiResponse, ProcessContentBatchRequest, ProcessContentRequest, ProcessContentResponse, UploadSignalRequest, ProtectionScopesRequest, ProtectionScopesResponse, GraphUserInfoContainer } from '../config/types';
export declare class PurviewClient {
    private readonly config;
    private readonly logger;
    private readonly retryHandler;
    private authToken;
    private readonly baseUrl;
    constructor(config: ActionConfig);
    setAuthToken(token: string): void;
    queueConversationMessage(payload: PurviewPayload): Promise<ApiResponse>;
    processContentAsync(payload: ProcessContentBatchRequest): Promise<ApiResponse>;
    processContent(userId: string, request: ProcessContentRequest, scopeIdentifier: string, inline?: boolean): Promise<ApiResponse<ProcessContentResponse>>;
    uploadSignal(payload: UploadSignalRequest): Promise<ApiResponse>;
    searchTenantProtectionScope(payload: ProtectionScopesRequest): Promise<ApiResponse<ProtectionScopesResponse>>;
    searchUserProtectionScope(userId: string, payload: ProtectionScopesRequest): Promise<ApiResponse<ProtectionScopesResponse>>;
    getUserInfo(userEmails: string[]): Promise<ApiResponse<GraphUserInfoContainer>>;
    private sendRequest;
    private jsonReplacer;
    private generateRequestId;
    private sanitizeErrorResponse;
    /**
     * Produces a debug-safe JSON dump of a request payload.
     * Truncates `data` fields (which carry file content) to avoid multi-MB log output.
     */
    private summarisePayload;
}
//# sourceMappingURL=purviewClient.d.ts.map