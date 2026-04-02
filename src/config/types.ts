export interface ActionConfig {
  clientId: string;
  clientCertificatePem?: string;
  tenantId: string;
  purviewAccountName: string;
  purviewEndpoint: string;
  filePatterns: string[];
  excludePatterns?: string[];
  maxFileSize: number;
  debug: boolean;
  repository: RepositoryInfo;
  userId: string;
  userMappings?: UserMapping[];

  // First-run state tracking
  stateRepoBranch?: string;
  stateRepoToken?: string;
}

export interface RepositoryInfo {
  owner: string;
  repo: string;
  branch: string;
  sha: string;
  runId: string;
  runNumber: string;
}

export interface AuthToken {
  accessToken: string;
  expiresAt: Date;
}

export type CommitChangeType = 
| "unknown"
| "added"
| "removed"
| "modified"
| "renamed"
| "copied"
| "changed"
| "unchanged";

export interface FileMetadata {
  path: string;
  size: number;
  encoding: string;
  sha: string;
  content?: string;
  authorLogin?: string | null | undefined;
  authorEmail?: string | null | undefined;
  authorId?: string;
  committerLogin?: string | null | undefined;
  committerEmail?: string | null | undefined;
  committerId?: string;
  numberOfDeletions?: number;
  numberOfAdditions?: number;
  numberOfChanges?: number;
  typeOfChange?: CommitChangeType;
  commitTimestamp?: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
  etag?: string;
}

export type Result<T, E = Error> = 
  | { success: true; value: T }
  | { success: false; error: E };

// Azure AD Token Response
export interface AzureTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export interface GraphDataTypeBase {
    /** The @odata.type property name used in the JSON representation of the object. */
    "@odata.type": string;
}

export interface ProcessContentBatchRequest {
    processContentRequests: ProcessContentRequestItem[];
}

export interface ProcessContentRequestItem {
    contentToProcess: ContentToProcess;
    userId?: string;
    userEmail?: string;
    requestId: string;
}

export interface ContentToProcess {
    contentEntries: ProcessContentMetadataBase[];
    activityMetadata?: ActivityMetadata;
    deviceMetadata?: DeviceMetadata;
    integratedAppMetadata?: IntegratedAppMetadata;
    protectedAppMetadata?: ProtectedAppMetadata;
}

export interface ProcessContentMetadataBase extends GraphDataTypeBase {
    identifier: string;
    content: ContentBase;
    name: string;
    correlationId: string;
    sequenceNumber?: number;
    length?: number;
    isTruncated: boolean;
    createdDateTime: string; // ISO 8601 string
    modifiedDateTime: string; // ISO 8601 string
}

export interface ProcessConversationMetadata extends ProcessContentMetadataBase {
    "@odata.type": "microsoft.graph.processConversationMetadata";
    parentMessageId?: string;
    accessedResources_v2?: AccessedResourceDetails[];
    plugins?: AiInteractionPlugin[];
    agents?: AiAgentInfo[];
}

export interface ProcessFileMetadata extends ProcessContentMetadataBase {
    "@odata.type": "microsoft.graph.processFileMetadata";
    ownerId?: string;
}

export interface ContentBase extends GraphDataTypeBase {
    // No properties; serves as a base type.
}

export interface TextContent extends ContentBase {
  "@odata.type": "microsoft.graph.textContent";
  data: string;
}

export interface BinaryContent extends ContentBase {
  "@odata.type": "microsoft.graph.binaryContent";
  data: string; // This should be a base64 encoded byte string
}

export enum Activity {
    unknown = 0,
    uploadText = 1,
    uploadFile = 2,
    downloadText = 3,
    downloadFile = 4
}

export interface ActivityMetadata {
    activity: Activity;
}

export interface DeviceMetadata {
    deviceType?: string;
    ipAddress?: string;
    operatingSystemSpecifications?: OperatingSystemSpecifications;
}

export interface OperatingSystemSpecifications {
    operatingSystemPlatform: string;
    operatingSystemVersion: string;
}

export interface IntegratedAppMetadata {
    name: string;
    version: string;
}

export interface ProtectedAppMetadata extends IntegratedAppMetadata {
    applicationLocation: PolicyLocation;
}

export interface PolicyLocation extends GraphDataTypeBase {
    value: string;
}

export interface PolicyLocationApplication extends PolicyLocation {
  "@odata.type": "microsoft.graph.policyLocationApplication";
}

export interface PolicyLocationDomain extends PolicyLocation {
  "@odata.type": "microsoft.graph.policyLocationDomain";
}

export interface PolicyLocationUrl extends PolicyLocation {
  "@odata.type": "microsoft.graph.policyLocationUrl";
}

export interface AiInteractionPlugin {
    identifier: string;
    name: string;
    version: string;
}

export interface AiAgentInfo {
    identifier: string;
    name?: string;
    version?: string;
}

export interface AccessedResourceDetails {
    identifier: string;
    name: string;
    url?: string;
    labelId?: string;
    accessType?: ResourceAccessType;
    status?: ResourceAccessStatus;
    isCrossPromptInjectionDetected?: boolean;
}

export type ResourceAccessType = "none" | "read" | "write" | "create" | "unknownFutureValue";

export type ResourceAccessStatus = "failure" | "success" | "unknownFutureValue";

export interface UploadSignalRequest {
  id: string;
  userId: string;
  scopeIdentifier: string;
  contentMetadata: ContentToProcess;
  userEmail?: string | null | undefined; // Optional user email field
}

// Enum for protection scope activities (using union type for TypeScript)
export type ProtectionScopeActivities = 
  | "none"
  | "uploadText" 
  | "uploadFile"
  | "downloadText"
  | "downloadFile"
  | "unknownFutureValue";

// Enum for policy pivot property
type PolicyPivotProperty = 
  | "none"
  | "activity"
  | "location"
  | "unknownFutureValue";

// Main ProtectionScopesRequest interface
export interface ProtectionScopesRequest {
  /**
   * Activities to include in the scope
   */
  activities?: ProtectionScopeActivities;
  
  /**
   * Gets or sets the locations to compute protection scopes for.
   */
  locations?: PolicyLocation[];
  
  /**
   * Response aggregation pivot
   */
  pivotOn?: PolicyPivotProperty;
  
  /**
   * Device meta data
   */
  deviceMetadata?: DeviceMetadata;
  
  /**
   * Integrated app metadata
   */
  integratedAppMetadata?: IntegratedAppMetadata;
  
  /**
   * The correlation id of the request.
   * Note: This is ignored in JSON serialization in C#
   */
  correlationId?: string;
  
  /**
   * Scope ID, used to detect stale client scoping information
   * Note: This is ignored in JSON serialization in C#
   */
  scopeIdentifier?: string;
}

export interface PrFileContext {
  fileName: string,
  prId: string,
  repoOwner: string,
  repoName: string,
  branchName: string,
  baseName: string,
  fileSize: number,
  commitSha: string,
  commitTimestamp?: string,
  authorLogin: string | null | undefined,
  authorEmail?: string | null | undefined,
  title: string,
  numberOfDeletions: number,
  numberOfAdditions: number,
  numberOfChanges: number,
  typeOfChange: CommitChangeType,
}

export interface PrInfo {
  iterations: number,
  authorLogin: string | null | undefined,
  authorEmail: string | null | undefined,
  head: string,
  base: string,
  title: string,
  url: string | null | undefined,
}

export interface GraphUserInfoContainer {
  value: GraphUserInfo[];
}

export interface GraphUserInfo {
  id: string;
  userPrincipalName: string;
}

export interface ProtectionScopesResponse {
  value: PolicyScopes[],
}

export interface PolicyScopes {
  policyScope: PolicyBinding,
  locations: PolicyLocation[],
  activities: ProtectionScopeActivities,
  executionMode: string,
  policyActions: DlpActionInfo[],
}

export interface DlpActionInfo {
  action: string;
  restrictionAction?: string;
  policyName?: string;
  policyId?: string;
  ruleId?: string;
  ruleName?: string;
}

export interface PolicyBinding {
  inclusions: ScopeBase[],
  exclusions: ScopeBase[],
}

export interface ScopeBase {
  "@odata.type": string;
  identity: string;
}

export interface SplitPCRequests {
  processContentRequests: ProcessContentBatchRequest[];
  uploadSignalRequests: UploadSignalRequest[];
}

// --- Per-user ProcessContent (PC) types ---

export interface ProcessContentRequest {
  contentToProcess: ContentToProcess;
}

export interface ProcessContentResponse {
  id: string;
  protectionScopeState: ProtectionScopeState;
  policyActions: PolicyAction[];
  processingErrors: any[];
}

export type ProtectionScopeState = "notModified" | "modified";

export interface PolicyAction {
  action: string;
  restrictionAction?: string;
  policyName?: string;
  policyId?: string;
  ruleId?: string;
  ruleName?: string;
}

export interface BlockedFileResult {
  filePath: string;
  userId: string;
  policyActions: PolicyAction[];
}

export enum ExecutionMode {
  evaluateInline = "evaluateInline",
  evaluateOffline = "evaluateOffline",
}

export interface ScopeCheckResult {
  shouldProcess: boolean;
  dlpActions: DlpActionInfo[];
  executionMode: ExecutionMode;
}

export interface CommitInfo {
    sha: string;
    email: string | undefined;
    committerEmail?: string;
    message?: string;
}

export interface CommitFiles {
  sha: string;
  files: FileMetadata[];
  message?: string;
  authorEmail?: string;
  authorLogin?: string;
  authorName?: string;
  authorId?: string;
  committerEmail?: string;
  committerLogin?: string;
  committerName?: string;
  committerId?: string;
  timestamp?: string;
}

// --- User mapping from users.json ---

export interface UsersConfig {
  users: UserMapping[];
  defaultUserId: string;
}

export interface UserMapping {
  email: string;
  userId: string;
}

export interface StateTrackingInfo {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

// Process environment type augmentation
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      GITHUB_TOKEN?: string;
      RUNNER_DEBUG?: string;
      CHANGED_FILES?: string;
      [key: string]: string | undefined;
    }
  }
}