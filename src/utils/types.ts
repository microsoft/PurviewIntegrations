// --- Configuration & Internal Types ---

export interface ActionConfig {
  endpoint: string;
  userPrincipalName: string;
  tenantId: string;
  aadResource: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  maxFileBytes: number;
  sliceLargeFiles: boolean;
  skipBinary: boolean;
  includeSummaryPayload: boolean;
  minify: boolean;
  failOnNon2xx: boolean;
  appHostName: string;
  applicationHostCategories: string[];
  debug: boolean;
}

export interface FilePayload {
  filePath: string;
  content: string; // Plaintext or Base64
  isBinary: boolean;
  isSliced: boolean;
  sliceIndex?: number;
  totalSlices?: number;
}

// --- Purview API Payload Types ---

export interface PurviewPayload {
  clientInfo: {
    clientName: string;
    version: string;
    ClientIp: string;
  };
  messageGroups: PurviewMessageGroup[];
}

export interface PurviewMessageGroup {
  messageGroupId: string;
  messageGroupSubject: string;
  messageGroupTenantId: string;
  messages: PurviewMessage[];
  appHostInfo: PurviewAppHostInfo;
  messageGroupParticipants: PurviewParticipant[];
}

export interface PurviewMessage {
  timestamp: string;
  lastModifiedDate: string;
  messageLocale: string;
  messageClientIp: string;
  messageId: number;
  messageType: number;
  messageFrom: PurviewParticipant;
  content: PurviewContent[];
  reaction: string;
  accessedResources: any[];
  modelInfo: {
    modelProviderName: string;
    modelName: string;
    modelVersion: string;
  };
  deviceInfo: {
    deviceManagementType: number;
    deviceType: string;
    operatingSystemPlatform: string;
    operatingSystemVersion: string;
  };
}

export interface PurviewParticipant {
  tenantId: string;
  displayName: string;
  recipientType: number;
  userPrincipalName: string;
}

export interface PurviewContent {
  Id: string;
  ContentType: number; // 0 for Raw text/base64
  Content: string;
}

export interface PurviewAppHostInfo {
  AppHostName: string;
  ChildAppHostName: string;
  AppHostFQDN: string;
  AppHostVersion: string;
  ApplicationHostCategories: string[];
}