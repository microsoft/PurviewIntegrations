import { ActionConfig, FileMetadata, PurviewPayload, UploadSignalRequest, Activity, PrInfo, ProtectionScopesRequest, ProtectionScopesResponse, SplitPCRequests, ProcessContentBatchRequest, ProcessContentRequest, ScopeCheckResult, PolicyScopes, PolicyLocation } from '../config/types';
export declare class PayloadBuilder {
    private readonly config;
    private readonly logger;
    private readonly maxPayloadSize;
    private static readonly domain;
    private static readonly scopeActivity;
    constructor(config: ActionConfig);
    build(files: FileMetadata[]): Promise<PurviewPayload>;
    buildProtectionScopesRequest(): ProtectionScopesRequest;
    buildProcessAndUploadRequests(files: FileMetadata[], scopeResponse: ProtectionScopesResponse, prInfo: PrInfo): SplitPCRequests;
    /**
     * Check protection scopes to determine if content should be processed inline, offline, or sent as content activities.
     * Mirrors the Python agent-framework `_check_applicable_scopes` logic:
     * - Bitwise activity matching
     * - Location matching by OData type suffix + exact value
     * - Sticky evaluateInline upgrade across scopes
     * - Accumulates policyActions from all matching scopes
     */
    checkApplicableScopes(scopes: PolicyScopes[], requestActivity: Activity, requestLocation: PolicyLocation): ScopeCheckResult;
    /**
     * Build a per-user ProcessContentRequest for inline PC calls.
     */
    buildPerUserProcessContentRequest(file: FileMetadata, conversationId: string, messageId: number): ProcessContentRequest;
    private matchActivity;
    buildUploadSignalRequest(files: FileMetadata[], prInfo: PrInfo): UploadSignalRequest[];
    buildProcessContentBatchRequest(files: FileMetadata[]): ProcessContentBatchRequest;
    private createContentToProcess;
    private createMetadataMessage;
    private createFileMessages;
    private chunkContent;
    private truncatePayload;
    private generateConversationId;
    private generateMessageId;
    private getFileTypes;
    private detectLanguage;
}
//# sourceMappingURL=payloadBuilder.d.ts.map