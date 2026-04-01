import { ActionConfig, FileMetadata, UploadSignalRequest, Activity, TextContent, PrInfo, ProtectionScopesRequest, ProtectionScopesResponse, SplitPCRequests, ProtectionScopeActivities, ProcessContentBatchRequest, ProcessContentRequestItem, ProcessContentRequest, ContentToProcess, ScopeCheckResult, ExecutionMode, PolicyScopes, PolicyLocation, DlpActionInfo, CommitFiles, AiAgentInfo, ProcessConversationMetadata } from '../config/types';
import { Logger } from '../utils/logger';

export class PayloadBuilder {
  private readonly logger: Logger;
  private readonly maxPayloadSize = 1024 * 1024 * 3; // 3MB
  private static readonly domain: string = "github.com";
  private static readonly scopeActivity: ProtectionScopeActivities = "uploadText";
  private static readonly appName = "GitHub";
  private static readonly appVersion = "0.0.1";
  private static readonly correlationIdSuffix = "@GA";
  
  constructor(private readonly config: ActionConfig) {
    this.logger = new Logger('PayloadBuilder');
  }

  buildProtectionScopesRequest(): ProtectionScopesRequest {
    const request: ProtectionScopesRequest = {
      activities: PayloadBuilder.scopeActivity,
      locations: [
        {
          "@odata.type": "microsoft.graph.policyLocationDomain",
          value: `https://${PayloadBuilder.domain}`
        }
      ],
      integratedAppMetadata: {
        name: PayloadBuilder.appName,
        version: PayloadBuilder.appVersion,
      },
    };

    return request;
  }

  buildProcessAndUploadRequests(files: FileMetadata[], scopeResponse: ProtectionScopesResponse, prInfo: PrInfo): SplitPCRequests {
    const filesToProcess: FileMetadata[] = [];
    const filesToUpload: FileMetadata[] = [];

    for (const file of files) {
      let shouldProcessFile: boolean = false;

      for (const scope of scopeResponse.value) {
        if (!shouldProcessFile && scope.activities.toLowerCase().includes("uploadtext")) {

          let locationMatch = false;
          let isIncluded = false;
          let isExcluded = false;

          const clientId = this.config.clientId.toLowerCase();

          // Check locations for domain or application match
          for (const location of scope.locations) {
            const locationValue = location.value.toLowerCase();

            if (locationValue === "all") {
              locationMatch = true;
              break;
            }
            else if (location["@odata.type"].endsWith("policyLocationDomain") && (locationValue.includes("github.com"))) {
              locationMatch = true;
              break;
            }
            else if (location["@odata.type"].endsWith("policyLocationApplication") && locationValue === clientId) {
              locationMatch = true;
              break;
            }
          }

          const authorId = (file.authorId || this.config.userId).toLowerCase();
          const tenantId = this.config.tenantId.toLowerCase();

          for (const inclusion of scope.policyScope.inclusions) {
            const inclusionIdentity = inclusion.identity.toLowerCase();

            if (inclusionIdentity === "all") {
              isIncluded = true;
              break;
            }
            else if (inclusion["@odata.type"].endsWith("tenantScope") && inclusionIdentity === tenantId) {
              isIncluded = true;
              break;
            }
            else if (inclusion["@odata.type"].endsWith("userScope") && inclusionIdentity === authorId) {
              isIncluded = true;
              break;
            }
          }

          for (const exclusion of scope.policyScope.exclusions) {
            const exclusionIdentity = exclusion.identity.toLowerCase();

            if (exclusionIdentity === "all") {
              isExcluded = true;
              break;
            }
            if (exclusion["@odata.type"].endsWith("tenantScope") && exclusionIdentity === tenantId) {
              isExcluded = false;
              break;
            }
            else if (exclusion["@odata.type"].endsWith("userScope") && exclusionIdentity === authorId) {
              isExcluded = false;
              break;
            }
          }

          if (locationMatch && isIncluded && !isExcluded) {
            shouldProcessFile = true;
            this.logger.info(`File ${file.path} is in scope.`);
            break;
          }
        }
      }

      if (shouldProcessFile) {
        filesToProcess.push(file);
      } else {
        filesToUpload.push(file);
      }
    }

    this.logger.info(`Files to process: ${filesToProcess.length}, Files to upload: ${filesToUpload.length}`);

    const uploadSignalRequests = filesToUpload.length > 0 ? this.buildUploadSignalRequest(filesToUpload, prInfo) : [];
    const pcbRequests = filesToProcess.length > 0 ? this.buildProcessContentBatchRequest(filesToProcess) : [];

    return {
      uploadSignalRequests: uploadSignalRequests,
      processContentRequests: pcbRequests
    };
  }

  /**
   * Check protection scopes to determine if content should be processed inline, offline, or sent as content activities.
   * Mirrors the Python agent-framework `_check_applicable_scopes` logic:
   * - Bitwise activity matching
   * - Location matching by OData type suffix + exact value
   * - Sticky evaluateInline upgrade across scopes
   * - Accumulates policyActions from all matching scopes
   */
  checkApplicableScopes(
    scopes: PolicyScopes[],
    requestActivity: Activity,
    requestLocation: PolicyLocation
  ): ScopeCheckResult {
    let shouldProcess = false;
    const dlpActions: DlpActionInfo[] = [];
    let executionMode: ExecutionMode = ExecutionMode.evaluateOffline;

    for (const scope of scopes) {
      // Activity match: check if the scope's activity flag covers our request activity
      const activityMatch = this.matchActivity(scope.activities, requestActivity);

      const clientId: string = this.config.clientId.toLowerCase();
      const requestLocationType = requestLocation["@odata.type"].split(".").pop()?.toLowerCase() || "";

      // Location match: check OData type suffix + exact value
      let locationMatch = false;
      if (requestLocation) {
        for (const loc of scope.locations || []) {
          if (loc["@odata.type"] && requestLocationType) {
            const locDataType = loc["@odata.type"].toLowerCase();

            // Match if both properties of scope location match request location
            if (locDataType.endsWith(requestLocationType) && loc.value.toLowerCase() === requestLocation.value.toLowerCase()) {
              locationMatch = true;
              break;
            }
            // Or match if the location is a policyLocationApplication with a clientId match
            else if(locDataType.endsWith("policylocationapplication") && loc.value.toLowerCase() === clientId) {
              locationMatch = true;
              break;
            }
          }
        }
      }

      if (activityMatch && locationMatch) {
        shouldProcess = true;
        // Sticky upgrade: if any matching scope says evaluateInline, we use inline
        if (scope.executionMode === ExecutionMode.evaluateInline) {
          executionMode = ExecutionMode.evaluateInline;
        }
        if (scope.policyActions) {
          dlpActions.push(...scope.policyActions);
        }
      }
    }

    this.logger.info(
      `Scope check result: shouldProcess=${shouldProcess}, executionMode=${executionMode}, matchingActions=${dlpActions.length}`
    );

    return { shouldProcess, dlpActions, executionMode };
  }

  /**
   * Build a per-user ProcessContentRequest for inline PC calls.
   */
  buildPerUserProcessContentRequest(file: FileMetadata, conversationId: string, messageId: number): ProcessContentRequest[] {
    const content = file.content || `File: ${file.path} (${file.size} bytes)`;
    const singleCTP = this.createContentToProcess(file, conversationId, messageId);
    const singleRequest: ProcessContentRequest = { contentToProcess: singleCTP };
    const requestSize = JSON.stringify(singleRequest).length;

    if (requestSize <= this.maxPayloadSize) {
      return [singleRequest];
    }

    // Split content into chunks that fit within maxPayloadSize
    const overhead = requestSize - content.length;
    const maxContentPerChunk = this.maxPayloadSize - overhead - 100; // safety margin
    const requests: ProcessContentRequest[] = [];

    for (let i = 0; i < content.length; i += maxContentPerChunk) {
      const chunk = content.substring(i, Math.min(i + maxContentPerChunk, content.length));
      const isLastChunk = i + maxContentPerChunk >= content.length;
      const chunkCTP = this.createContentToProcess(file, conversationId, messageId + requests.length, !isLastChunk, chunk);
      requests.push({ contentToProcess: chunkCTP });
    }

    this.logger.info(`Split file ${file.path} into ${requests.length} processContent request(s)`);
    return requests;
  }

  private matchActivity(scopeActivities: ProtectionScopeActivities, requestActivity: Activity): boolean {
    // Map Activity enum to the string used in protection scope responses
    const activityMap: Record<number, string> = {
      [Activity.uploadText]: "uploadtext",
      [Activity.uploadFile]: "uploadfile",
      [Activity.downloadText]: "downloadtext",
      [Activity.downloadFile]: "downloadfile",
    };
    const expected = activityMap[requestActivity];
    if (!expected) return false;

    const scopeStr = (typeof scopeActivities === 'string' ? scopeActivities : '').toLowerCase();
    return scopeStr.includes(expected);
  }

  buildUploadSignalRequest(files: FileMetadata[], prInfo: PrInfo): UploadSignalRequest[] {
    const requests: UploadSignalRequest[] = [];
    const conversationId = crypto.randomUUID() + PayloadBuilder.correlationIdSuffix;
    let seqNum = 0;

    for (const file of files) {
      this.logger.info(`Building upload signal request for file: ${file.path}`);

      const content = file.content || `File: ${file.path} (${file.size} bytes)`;
      const userId = file.authorId || this.config.userId;
      const userEmail = file.authorEmail || prInfo.authorEmail;

      const singleCTP = this.createContentToProcess(file, conversationId, seqNum);
      const singleSize = JSON.stringify(singleCTP).length + 200; // account for wrapper fields

      if (singleSize <= this.maxPayloadSize) {
        requests.push({
          id: crypto.randomUUID() + PayloadBuilder.correlationIdSuffix,
          userId,
          userEmail,
          scopeIdentifier: "",
          contentMetadata: singleCTP,
        });
        seqNum++;
      } else {
        // Split content into chunks
        const overhead = singleSize - content.length;
        const maxContentPerChunk = this.maxPayloadSize - overhead - 100;

        for (let i = 0; i < content.length; i += maxContentPerChunk) {
          const chunk = content.substring(i, Math.min(i + maxContentPerChunk, content.length));
          const isLastChunk = i + maxContentPerChunk >= content.length;
          const chunkCTP = this.createContentToProcess(file, conversationId, seqNum, !isLastChunk, chunk);
          requests.push({
            id: crypto.randomUUID() + PayloadBuilder.correlationIdSuffix,
            userId,
            userEmail,
            scopeIdentifier: "",
            contentMetadata: chunkCTP,
          });
          seqNum++;
        }
        this.logger.info(`Split file ${file.path} into multiple upload signal request(s)`);
      }
    }

    return requests;
  }

  buildProcessContentBatchRequest(files: FileMetadata[]): ProcessContentBatchRequest[] {
    const allItems: ProcessContentRequestItem[] = [];
    const conversationId = crypto.randomUUID() + PayloadBuilder.correlationIdSuffix;
    let seqNum = 0;

    for (const file of files) {
      const content = file.content || `File: ${file.path} (${file.size} bytes)`;
      const userId = file.authorId || this.config.userId;
      const singleCTP = this.createContentToProcess(file, conversationId, seqNum);
      const singleItem: ProcessContentRequestItem = {
        contentToProcess: singleCTP,
        userId,
        requestId: crypto.randomUUID(),
      };
      const itemSize = JSON.stringify(singleItem).length;

      if (itemSize <= this.maxPayloadSize) {
        allItems.push(singleItem);
        seqNum++;
      } else {
        // Single file exceeds limit — split its content into chunks
        const overhead = itemSize - content.length;
        const maxContentPerChunk = this.maxPayloadSize - overhead - 100;

        for (let i = 0; i < content.length; i += maxContentPerChunk) {
          const chunk = content.substring(i, Math.min(i + maxContentPerChunk, content.length));
          const isLastChunk = i + maxContentPerChunk >= content.length;
          const chunkCTP = this.createContentToProcess(file, conversationId, seqNum, !isLastChunk, chunk);
          allItems.push({
            contentToProcess: chunkCTP,
            userId,
            requestId: crypto.randomUUID(),
          });
          seqNum++;
        }
      }
    }

    // Split items into batches that fit within maxPayloadSize
    const batches: ProcessContentBatchRequest[] = [];
    let currentItems: ProcessContentRequestItem[] = [];
    let currentSize = 0;
    const batchOverhead = 50;

    for (const item of allItems) {
      const itemSize = JSON.stringify(item).length;
      if (currentItems.length > 0 && currentSize + itemSize + batchOverhead > this.maxPayloadSize) {
        batches.push({ processContentRequests: currentItems });
        currentItems = [];
        currentSize = 0;
      }
      currentItems.push(item);
      currentSize += itemSize;
    }

    if (currentItems.length > 0) {
      batches.push({ processContentRequests: currentItems });
    }

    return batches;
  }
  
  private createContentToProcess(file: FileMetadata, conversationId: string, messageId: number, isTruncated: boolean = false, contentOverride?: string): ContentToProcess {
    let userId = file.authorId;
    const usingDefaultUser = !userId || userId === this.config.userId;

    if (!userId) {
      this.logger.warn(`No user ID found for file: ${file.path} with author ${file.authorEmail}}, using default user ID`);
      userId = this.config.userId;
    }

    const now = new Date().toISOString();
    
    let fileContent: TextContent = {
      "@odata.type": "microsoft.graph.textContent",
      data: contentOverride ?? file.content ?? `File: ${file.path} (${file.size} bytes)`
    };

    const agents: AiAgentInfo[] = [];
    if (file.committerId || file.committerEmail) {
      agents.push({
        identifier: file.committerId || file.committerEmail || '',
        name: file.committerLogin || file.committerEmail || undefined,
        version: usingDefaultUser ? this.config.userId : undefined,
      });
    }

    const entry: ProcessConversationMetadata = {
      "@odata.type": "microsoft.graph.processConversationMetadata",
      identifier: file.path,
      name: file.path,
      correlationId: conversationId,
      sequenceNumber: messageId,
      length: file.size,
      isTruncated,
      createdDateTime: now,
      modifiedDateTime: now,
      content: fileContent,
      ...(agents.length > 0 ? { agents } : {}),
    };

    return {
      contentEntries: [entry],
      activityMetadata: {
        activity: Activity.uploadText,
      },
      deviceMetadata: {},
      integratedAppMetadata: {
        name: PayloadBuilder.appName,
        version: PayloadBuilder.appVersion,
      },
      protectedAppMetadata: {
        name: PayloadBuilder.appName,
        version: PayloadBuilder.appVersion,
        applicationLocation: {
          "@odata.type": "microsoft.graph.policyLocationDomain",
          value: `https://${PayloadBuilder.domain}`
        }
      }
    };
  }

  /**
   * Build the text content representing a git commit's metadata.
   */
  private buildCommitContentText(commitGroup: CommitFiles): string {
    const lines: string[] = [
      `Commit: ${commitGroup.sha}`,
    ];

    if (commitGroup.message) {
      lines.push(`Message: ${commitGroup.message}`);
    }
    if (commitGroup.authorName || commitGroup.authorEmail) {
      lines.push(`Author: ${commitGroup.authorName || ''} <${commitGroup.authorEmail || ''}>`);
    }
    if (commitGroup.committerName || commitGroup.committerEmail) {
      lines.push(`Committer: ${commitGroup.committerName || ''} <${commitGroup.committerEmail || ''}>`);
    }
    if (commitGroup.timestamp) {
      lines.push(`Date: ${commitGroup.timestamp}`);
    }

    if (commitGroup.files.length > 0) {
      lines.push('', 'Changed files:');
      for (const file of commitGroup.files) {
        const changeType = file.typeOfChange || 'modified';
        const additions = file.numberOfAdditions ?? 0;
        const deletions = file.numberOfDeletions ?? 0;
        lines.push(`  ${changeType}: ${file.path} (+${additions} -${deletions})`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Build a ContentToProcess for a git commit (commit-level metadata request).
   */
  buildCommitContentToProcess(commitGroup: CommitFiles, conversationId: string, sequenceNumber: number): ContentToProcess {
    const now = new Date().toISOString();
    const commitContent = this.buildCommitContentText(commitGroup);
    const commitIdentifier = `commit:${commitGroup.sha}`;
    const usingDefaultUser = !commitGroup.authorId || commitGroup.authorId === this.config.userId;

    const fileContent: TextContent = {
      "@odata.type": "microsoft.graph.textContent",
      data: commitContent,
    };

    const agents: AiAgentInfo[] = [];
    if (commitGroup.committerId || commitGroup.committerEmail) {
      agents.push({
        identifier: commitGroup.committerId || commitGroup.committerEmail || '',
        name: commitGroup.committerLogin || commitGroup.committerEmail || undefined,
        version: usingDefaultUser ? this.config.userId : undefined,
      });
    }

    const entry: ProcessConversationMetadata = {
      "@odata.type": "microsoft.graph.processConversationMetadata",
      identifier: commitIdentifier,
      name: commitIdentifier,
      correlationId: conversationId,
      sequenceNumber,
      length: commitContent.length,
      isTruncated: false,
      createdDateTime: commitGroup.timestamp || now,
      modifiedDateTime: commitGroup.timestamp || now,
      content: fileContent,
      ...(agents.length > 0 ? { agents } : {}),
    };

    return {
      contentEntries: [entry],
      activityMetadata: {
        activity: Activity.uploadText,
      },
      deviceMetadata: {},
      integratedAppMetadata: {
        name: PayloadBuilder.appName,
        version: PayloadBuilder.appVersion,
      },
      protectedAppMetadata: {
        name: PayloadBuilder.appName,
        version: PayloadBuilder.appVersion,
        applicationLocation: {
          "@odata.type": "microsoft.graph.policyLocationDomain",
          value: `https://${PayloadBuilder.domain}`,
        },
      },
    };
  }

  /**
   * Build a per-user ProcessContentRequest for a git commit (inline PC).
   */
  buildCommitProcessContentRequest(commitGroup: CommitFiles, conversationId: string, sequenceNumber: number): ProcessContentRequest {
    const ctp = this.buildCommitContentToProcess(commitGroup, conversationId, sequenceNumber);
    return { contentToProcess: ctp };
  }

  /**
   * Build an UploadSignalRequest for a git commit (contentActivities fallback).
   */
  buildCommitUploadSignalRequest(commitGroup: CommitFiles, prInfo: PrInfo): UploadSignalRequest {
    const conversationId = crypto.randomUUID() + PayloadBuilder.correlationIdSuffix;
    const ctp = this.buildCommitContentToProcess(commitGroup, conversationId, 0);
    const userId = commitGroup.authorId || this.config.userId;
    const userEmail = commitGroup.authorEmail || prInfo.authorEmail;

    return {
      id: crypto.randomUUID() + PayloadBuilder.correlationIdSuffix,
      userId,
      userEmail,
      scopeIdentifier: "",
      contentMetadata: ctp,
    };
  }

  /**
   * Build a ProcessContentBatchRequest item for a git commit (PCA batch).
   */
  buildCommitProcessContentBatchItem(commitGroup: CommitFiles, conversationId: string, sequenceNumber: number): ProcessContentRequestItem {
    const ctp = this.buildCommitContentToProcess(commitGroup, conversationId, sequenceNumber);
    return {
      contentToProcess: ctp,
      userId: commitGroup.authorId || this.config.userId,
      requestId: crypto.randomUUID(),
    };
  }

}