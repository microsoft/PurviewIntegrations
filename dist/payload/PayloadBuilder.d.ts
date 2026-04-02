import { ActionConfig, FileMetadata, UploadSignalRequest, Activity, PrInfo, ProtectionScopesRequest, ProtectionScopesResponse, SplitPCRequests, ProcessContentBatchRequest, ProcessContentRequestItem, ProcessContentRequest, ContentToProcess, ScopeCheckResult, PolicyScopes, PolicyLocation, CommitFiles } from '../config/types';
export declare class PayloadBuilder {
    private readonly config;
    private readonly logger;
    private readonly maxPayloadSize;
    private static readonly domain;
    private static readonly scopeActivity;
    private static readonly appName;
    private static readonly appVersion;
    private static readonly correlationIdSuffix;
    /** When true, agent version is set to "fullscan" instead of the defaultUserId. */
    isFullScan: boolean;
    /** PR number, set when processing a pull request event. */
    prNumber?: number;
    constructor(config: ActionConfig);
    private buildResourceIdentifier;
    private buildFileResourceName;
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
    buildPerUserProcessContentRequest(file: FileMetadata, conversationId: string, messageId: number): ProcessContentRequest[];
    private matchActivity;
    buildUploadSignalRequest(files: FileMetadata[], prInfo: PrInfo): UploadSignalRequest[];
    buildProcessContentBatchRequest(files: FileMetadata[]): ProcessContentBatchRequest[];
    private createContentToProcess;
    /**
     * Build the text content representing a git commit's metadata.
     */
    private buildCommitContentText;
    /**
     * Build a ContentToProcess for a git commit (commit-level metadata request).
     */
    buildCommitContentToProcess(commitGroup: CommitFiles, conversationId: string, sequenceNumber: number): ContentToProcess;
    /**
     * Build a per-user ProcessContentRequest for a git commit (inline PC).
     */
    buildCommitProcessContentRequest(commitGroup: CommitFiles, conversationId: string, sequenceNumber: number): ProcessContentRequest;
    /**
     * Build an UploadSignalRequest for a git commit (contentActivities fallback).
     */
    buildCommitUploadSignalRequest(commitGroup: CommitFiles, prInfo: PrInfo): UploadSignalRequest;
    /**
     * Build a ProcessContentBatchRequest item for a git commit (PCA batch).
     */
    buildCommitProcessContentBatchItem(commitGroup: CommitFiles, conversationId: string, sequenceNumber: number): ProcessContentRequestItem;
    private mapChangeTypeToAccessType;
}
//# sourceMappingURL=payloadBuilder.d.ts.map