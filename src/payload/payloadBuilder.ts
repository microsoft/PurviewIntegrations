import { ActionConfig, FileMetadata, UploadSignalRequest, Activity, TextContent, PrInfo, ProtectionScopesRequest, ProtectionScopesResponse, SplitPCRequests, ProtectionScopeActivities, ProcessContentBatchRequest, ProcessContentRequestItem, ProcessContentRequest, ContentToProcess, ScopeCheckResult, ExecutionMode, PolicyScopes, PolicyLocation, DlpActionInfo, CommitFiles, AiAgentInfo, ProcessConversationMetadata } from '../config/types';
import { Logger } from '../utils/logger';

export class PayloadBuilder {
  private readonly logger: Logger;
  private readonly maxContentSize = 1024 * 1024 * 3;       // 3 MB — max for the content data field
  private readonly maxRequestSize = 1024 * 1024 * 3.7;     // 3.7 MB — max for the complete request
  private static readonly domain: string = "github.com";
  private static readonly scopeActivity: ProtectionScopeActivities = "uploadText";
  private static readonly appName = "GitHub";
  private static readonly appVersion = "0.0.1";
  private static readonly correlationIdSuffix = "@GA";

  /** When true, agent version is set to "fullscan" instead of the defaultUserId. */
  public isFullScan = false;

  /** PR number, set when processing a pull request event. */
  public prNumber?: number;

  /** PR description/body, set when processing a pull request event. */
  public prDescription?: string;
  
  constructor(private readonly config: ActionConfig) {
    this.logger = new Logger('PayloadBuilder');
  }

  private buildResourceIdentifier(commitOrSha: string): string {
    return this.prNumber != null
      ? `PR: ${this.prNumber} Commit: ${commitOrSha}`
      : `Commit: ${commitOrSha}`;
  }

  private buildFileResourceName(filePath: string): string {
    const fileName = filePath.split('/').pop() || filePath;
    return `Repo: ${this.config.repository.repo} File: ${fileName} Path: ${filePath}`;
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
            this.logger.debug(`File ${file.path} is in scope.`);
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

    this.logger.debug(
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

    if (requestSize <= this.maxRequestSize) {
      return [singleRequest];
    }

    // Split content into chunks that fit within maxContentSize
    const overhead = requestSize - content.length;
    const maxContentPerChunk = this.maxContentSize - overhead - 100; // safety margin
    const requests: ProcessContentRequest[] = [];

    let partNumber = 1;
    for (let i = 0; i < content.length; i += maxContentPerChunk) {
      const chunk = content.substring(i, Math.min(i + maxContentPerChunk, content.length));
      const isLastChunk = i + maxContentPerChunk >= content.length;
      const chunkCTP = this.createContentToProcess(file, conversationId, messageId + requests.length, !isLastChunk, chunk, partNumber);
      requests.push({ contentToProcess: chunkCTP });
      partNumber++;
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
      this.logger.debug(`Building upload signal request for file: ${file.path}`);

      const content = file.content || `File: ${file.path} (${file.size} bytes)`;
      const userId = file.authorId || this.config.userId;
      const userEmail = file.authorEmail || prInfo.authorEmail;

      const singleCTP = this.createContentToProcess(file, conversationId, seqNum);
      const singleSize = JSON.stringify(singleCTP).length + 200; // account for wrapper fields

      if (singleSize <= this.maxRequestSize) {
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
        const maxContentPerChunk = this.maxContentSize - overhead - 100;

        let partNumber = 1;
        for (let i = 0; i < content.length; i += maxContentPerChunk) {
          const chunk = content.substring(i, Math.min(i + maxContentPerChunk, content.length));
          const isLastChunk = i + maxContentPerChunk >= content.length;
          const chunkCTP = this.createContentToProcess(file, conversationId, seqNum, !isLastChunk, chunk, partNumber);
          requests.push({
            id: crypto.randomUUID() + PayloadBuilder.correlationIdSuffix,
            userId,
            userEmail,
            scopeIdentifier: "",
            contentMetadata: chunkCTP,
          });
          seqNum++;
          partNumber++;
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
      const userEmail = file.authorEmail || undefined;
      const singleCTP = this.createContentToProcess(file, conversationId, seqNum);
      const singleItem: ProcessContentRequestItem = {
        contentToProcess: singleCTP,
        userId,
        userEmail,
        requestId: crypto.randomUUID(),
      };
      const itemSize = JSON.stringify(singleItem).length;

      if (itemSize <= this.maxRequestSize) {
        allItems.push(singleItem);
        seqNum++;
      } else {
        // Single file exceeds limit — split its content into chunks
        const overhead = itemSize - content.length;
        const maxContentPerChunk = this.maxContentSize - overhead - 100;

        let partNumber = 1;
        for (let i = 0; i < content.length; i += maxContentPerChunk) {
          const chunk = content.substring(i, Math.min(i + maxContentPerChunk, content.length));
          const isLastChunk = i + maxContentPerChunk >= content.length;
          const chunkCTP = this.createContentToProcess(file, conversationId, seqNum, !isLastChunk, chunk, partNumber);
          allItems.push({
            contentToProcess: chunkCTP,
            userId,
            userEmail,
            requestId: crypto.randomUUID(),
          });
          seqNum++;
          partNumber++;
        }
      }
    }

    // Split items into batches that fit within maxRequestSize
    const batches: ProcessContentBatchRequest[] = [];
    let currentItems: ProcessContentRequestItem[] = [];
    let currentSize = 0;
    const batchOverhead = 200;

    for (const item of allItems) {
      const itemSize = JSON.stringify(item).length;
      if (currentItems.length > 0 && currentSize + itemSize + batchOverhead > this.maxRequestSize) {
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
  
  private createContentToProcess(file: FileMetadata, conversationId: string, messageId: number, isTruncated: boolean = false, contentOverride?: string, partNumber?: number): ContentToProcess {
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
        name: file.committerEmail || undefined,
        version: this.isFullScan ? 'fullscan' : (usingDefaultUser ? this.config.userId : undefined),
      });
    }

    const repoBaseUrl = `https://${PayloadBuilder.domain}/${this.config.repository.owner}/${this.config.repository.repo}`;
    const fileUrl = `${repoBaseUrl}/blob/${this.config.repository.branch}/${file.path}`;

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
      accessedResources_v2: [{
        identifier: this.buildResourceIdentifier(file.sha || file.path),
        name: this.buildFileResourceName(file.path) + (partNumber != null ? ` Part: ${partNumber}` : ''),
        url: fileUrl,
        accessType: this.mapChangeTypeToAccessType(file.typeOfChange),
        status: 'success',
        isCrossPromptInjectionDetected: false,
      }],
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
    const lines: string[] = [];

    if (this.prNumber != null) {
      lines.push(`PR: #${this.prNumber}`);
      if (this.prDescription) {
        lines.push(`Description: ${this.prDescription}`);
      }
      lines.push('');
    }

    lines.push(`Commit: ${commitGroup.sha}`);

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
   * Build the accessedResources array for a commit.
   */
  private buildCommitAccessedResources(commitGroup: CommitFiles, partSuffix: string = ''): import('../config/types').AccessedResourceDetails[] {
    const repoBaseUrl = `https://${PayloadBuilder.domain}/${this.config.repository.owner}/${this.config.repository.repo}`;
    const commitUrl = `${repoBaseUrl}/commit/${commitGroup.sha}`;

    const resources: import('../config/types').AccessedResourceDetails[] = [{
      identifier: this.buildResourceIdentifier(commitGroup.sha),
      name: `Repo: ${this.config.repository.repo} Commit: ${commitGroup.sha}${partSuffix}`,
      url: commitUrl,
      accessType: 'write',
      status: 'success',
      isCrossPromptInjectionDetected: false,
    }];
    for (const file of commitGroup.files) {
      resources.push({
        identifier: this.buildResourceIdentifier(file.sha || file.path),
        name: this.buildFileResourceName(file.path) + partSuffix,
        url: `${repoBaseUrl}/blob/${this.config.repository.branch}/${file.path}`,
        accessType: this.mapChangeTypeToAccessType(file.typeOfChange),
        status: 'success',
        isCrossPromptInjectionDetected: false,
      });
    }
    return resources;
  }

  /**
   * Build a ContentToProcess for a git commit (commit-level metadata request).
   * Accepts optional accessedResources override for splitting large resource arrays.
   */
  buildCommitContentToProcess(
    commitGroup: CommitFiles, conversationId: string, sequenceNumber: number,
    isTruncated: boolean = false, contentOverride?: string, partNumber?: number,
    accessedResourcesOverride?: import('../config/types').AccessedResourceDetails[]
  ): ContentToProcess {
    const now = new Date().toISOString();
    const commitContent = contentOverride ?? this.buildCommitContentText(commitGroup);
    const commitIdentifier = `commit:${commitGroup.sha}`;
    const usingDefaultUser = !commitGroup.authorId || commitGroup.authorId === this.config.userId;

    const agents: AiAgentInfo[] = [];
    if (commitGroup.committerId || commitGroup.committerEmail) {
      agents.push({
        identifier: commitGroup.committerId || commitGroup.committerEmail || '',
        name: commitGroup.committerEmail || undefined,
        version: this.isFullScan ? 'fullscan' : (usingDefaultUser ? this.config.userId : undefined),
      });
    }

    const partSuffix = partNumber != null ? ` Part: ${partNumber}` : '';
    const accessedResources = accessedResourcesOverride ?? this.buildCommitAccessedResources(commitGroup, partSuffix);

    const textContent: TextContent = {
      "@odata.type": "microsoft.graph.textContent",
      data: commitContent,
    };
    const entry: ProcessConversationMetadata = {
      "@odata.type": "microsoft.graph.processConversationMetadata",
      identifier: commitIdentifier,
      name: commitIdentifier,
      correlationId: conversationId,
      sequenceNumber,
      length: commitContent.length,
      isTruncated,
      createdDateTime: commitGroup.timestamp || now,
      modifiedDateTime: commitGroup.timestamp || now,
      content: textContent,
      accessedResources_v2: accessedResources,
      ...(agents.length > 0 ? { agents } : {}),
    };

    return {
      contentEntries: [entry],
      activityMetadata: { activity: Activity.uploadText },
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
   * Build per-user ProcessContentRequest(s) for a git commit (inline PC).
   * Splits by content first, then by accessedResources if still too large.
   */
  buildCommitProcessContentRequest(commitGroup: CommitFiles, conversationId: string, sequenceNumber: number): ProcessContentRequest[] {
    const ctp = this.buildCommitContentToProcess(commitGroup, conversationId, sequenceNumber);
    const singleRequest: ProcessContentRequest = { contentToProcess: ctp };
    const requestSize = JSON.stringify(singleRequest).length;

    if (requestSize <= this.maxRequestSize) {
      return [singleRequest];
    }

    // Split needed — delegate to the common commit splitting helper
    return this.splitCommitRequests(commitGroup, conversationId, sequenceNumber,
      (c) => ({ contentToProcess: c } as ProcessContentRequest));
  }

  /**
   * Build UploadSignalRequest(s) for a git commit (contentActivities fallback).
   * Splits by content first, then by accessedResources if still too large.
   */
  buildCommitUploadSignalRequest(commitGroup: CommitFiles, prInfo: PrInfo): UploadSignalRequest[] {
    const conversationId = crypto.randomUUID() + PayloadBuilder.correlationIdSuffix;
    const userId = commitGroup.authorId || this.config.userId;
    const userEmail = commitGroup.authorEmail || prInfo.authorEmail;

    const ctp = this.buildCommitContentToProcess(commitGroup, conversationId, 0);
    const singleRequest: UploadSignalRequest = {
      id: crypto.randomUUID() + PayloadBuilder.correlationIdSuffix,
      userId,
      userEmail,
      scopeIdentifier: "",
      contentMetadata: ctp,
    };

    if (JSON.stringify(singleRequest).length <= this.maxRequestSize) {
      return [singleRequest];
    }

    // Split needed — delegate to the common commit splitting helper
    return this.splitCommitRequests(commitGroup, conversationId, 0, (c) => ({
      id: crypto.randomUUID() + PayloadBuilder.correlationIdSuffix,
      userId,
      userEmail,
      scopeIdentifier: "",
      contentMetadata: c,
    } as UploadSignalRequest));
  }

  /**
   * Common helper: split a commit into multiple requests when it exceeds the
   * size limit. Splits content first; if accessedResources alone exceed the
   * limit, splits those across parts too.
   *
   * @param wrap — wraps a ContentToProcess into the final request type (T)
   */
  private splitCommitRequests<T>(
    commitGroup: CommitFiles, conversationId: string, startSeqNum: number,
    wrap: (ctp: ContentToProcess) => T
  ): T[] {
    const commitContent = this.buildCommitContentText(commitGroup);
    const allResources = this.buildCommitAccessedResources(commitGroup);

    // Measure overhead with empty content + full resources
    const probeCTP = this.buildCommitContentToProcess(
      commitGroup, conversationId, startSeqNum, false, '', undefined, allResources
    );
    const probeSize = JSON.stringify(wrap(probeCTP)).length;

    if (probeSize <= this.maxRequestSize) {
      // Content chunking alone is sufficient
      const maxChunk = Math.max(1, this.maxContentSize - (probeSize - commitContent.length) - 200);
      const results: T[] = [];
      let partNumber = 1;
      for (let i = 0; i < commitContent.length; i += maxChunk) {
        const chunk = commitContent.substring(i, Math.min(i + maxChunk, commitContent.length));
        const isLastChunk = i + maxChunk >= commitContent.length;
        const partSuffix = ` Part: ${partNumber}`;
        const resources = this.buildCommitAccessedResources(commitGroup, partSuffix);
        const ctp = this.buildCommitContentToProcess(
          commitGroup, conversationId, startSeqNum + results.length,
          !isLastChunk, chunk, partNumber, resources
        );
        results.push(wrap(ctp));
        partNumber++;
      }
      this.logger.info(`Split commit ${commitGroup.sha} content into ${results.length} part(s)`);
      return results;
    }

    // accessedResources alone exceed the limit — split resources across parts
    const singleResourceSize = allResources.length > 1
      ? JSON.stringify(allResources[1]).length + 2
      : 200;
    const resourceBudget = this.maxRequestSize - (probeSize - JSON.stringify(allResources).length) - 500;
    const resourcesPerPart = Math.max(1, Math.floor(resourceBudget / singleResourceSize));

    const results: T[] = [];
    let partNumber = 1;
    let contentRemaining = commitContent;

    for (let rIdx = 0; rIdx < allResources.length; rIdx += resourcesPerPart) {
      const resourceSlice = allResources.slice(rIdx, rIdx + resourcesPerPart);
      const partSuffix = ` Part: ${partNumber}`;
      const labeledResources = resourceSlice.map(r => ({ ...r, name: r.name + partSuffix }));

      // First part gets as much content as fits; subsequent parts get empty content
      let chunk = '';
      let isTruncated = false;
      if (contentRemaining.length > 0) {
        const resourceJsonSize = JSON.stringify(labeledResources).length;
        const wrapperOverhead = probeSize - JSON.stringify(allResources).length - commitContent.length;
        const contentBudget = Math.max(0, this.maxContentSize - wrapperOverhead - resourceJsonSize - 200);
        chunk = contentRemaining.substring(0, contentBudget);
        contentRemaining = contentRemaining.substring(contentBudget);
        isTruncated = contentRemaining.length > 0;
      }

      const ctp = this.buildCommitContentToProcess(
        commitGroup, conversationId, startSeqNum + results.length,
        isTruncated, chunk, partNumber, labeledResources
      );
      results.push(wrap(ctp));
      partNumber++;
    }

    // If content still remaining after all resource parts, add content-only parts
    if (contentRemaining.length > 0) {
      const emptyResources = this.buildCommitAccessedResources(commitGroup, ` Part: ${partNumber}`).slice(0, 1);
      const emptyProbe = this.buildCommitContentToProcess(
        commitGroup, conversationId, 0, false, '', undefined, emptyResources
      );
      const overhead = JSON.stringify(wrap(emptyProbe)).length;
      const maxChunk = Math.max(1, this.maxContentSize - overhead - 200);

      while (contentRemaining.length > 0) {
        const partSuffix = ` Part: ${partNumber}`;
        const resources = this.buildCommitAccessedResources(commitGroup, partSuffix).slice(0, 1);
        const chunk = contentRemaining.substring(0, maxChunk);
        contentRemaining = contentRemaining.substring(maxChunk);
        const ctp = this.buildCommitContentToProcess(
          commitGroup, conversationId, startSeqNum + results.length,
          contentRemaining.length > 0, chunk, partNumber, resources
        );
        results.push(wrap(ctp));
        partNumber++;
      }
    }

    this.logger.info(`Split commit ${commitGroup.sha} into ${results.length} part(s) (content + accessedResources)`);
    return results;
  }

  /**
   * Build a ProcessContentBatchRequest item for a git commit (PCA batch).
   * Returns multiple items if the commit content exceeds the size limit.
   */
  buildCommitProcessContentBatchItems(commitGroup: CommitFiles, conversationId: string, startSequenceNumber: number): ProcessContentRequestItem[] {
    const userId = commitGroup.authorId || this.config.userId;
    const userEmail = commitGroup.authorEmail || undefined;

    const singleCTP = this.buildCommitContentToProcess(commitGroup, conversationId, startSequenceNumber);
    const singleItem: ProcessContentRequestItem = {
      contentToProcess: singleCTP,
      userId,
      userEmail,
      requestId: crypto.randomUUID(),
    };

    if (JSON.stringify(singleItem).length <= this.maxRequestSize) {
      return [singleItem];
    }

    // Delegate to the common splitting helper
    return this.splitCommitRequests(commitGroup, conversationId, startSequenceNumber, (ctp) => ({
      contentToProcess: ctp,
      userId,
      userEmail,
      requestId: crypto.randomUUID(),
    } as ProcessContentRequestItem));
  }

  /**
   * Build batched PCA requests for one or more commits, combining items
   * into batches that fit within the payload size limit.
   */
  buildCommitProcessContentBatchRequest(commitGroups: CommitFiles[]): ProcessContentBatchRequest[] {
    const allItems: ProcessContentRequestItem[] = [];
    const conversationId = crypto.randomUUID() + PayloadBuilder.correlationIdSuffix;
    let seqNum = 0;

    for (const commitGroup of commitGroups) {
      const items = this.buildCommitProcessContentBatchItems(commitGroup, conversationId, seqNum);
      allItems.push(...items);
      seqNum += items.length;
    }

    // Split items into batches that fit within maxRequestSize
    const batches: ProcessContentBatchRequest[] = [];
    let currentItems: ProcessContentRequestItem[] = [];
    let currentSize = 0;
    const batchOverhead = 200;

    for (const item of allItems) {
      const itemSize = JSON.stringify(item).length;
      if (currentItems.length > 0 && currentSize + itemSize + batchOverhead > this.maxRequestSize) {
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

  private mapChangeTypeToAccessType(typeOfChange?: string): import('../config/types').ResourceAccessType {
    switch (typeOfChange) {
      case 'added':
      case 'copied':
        return 'create';
      case 'removed':
        return 'none';
      case 'modified':
      case 'renamed':
      case 'changed':
        return 'write';
      default:
        return 'write';
    }
  }

}