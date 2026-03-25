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