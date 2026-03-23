import { Activity, ExecutionMode } from '../config/types';
import { Logger } from '../utils/logger';
export class PayloadBuilder {
    config;
    logger;
    maxPayloadSize = 1024 * 1024 * 3; // 3MB
    static domain = "github.com";
    static scopeActivity = "uploadText";
    constructor(config) {
        this.config = config;
        this.logger = new Logger('PayloadBuilder');
    }
    async build(files) {
        const conversationId = this.generateConversationId();
        const allMessages = [];
        // Add metadata message
        allMessages.push(this.createMetadataMessage(files));
        // Add file messages
        for (const file of files) {
            const fileMessages = await this.createFileMessages(file);
            allMessages.push(...fileMessages);
        }
        // Split messages into payloads of <= maxPayloadSize
        const payloads = [];
        let currentMessages = [];
        let currentSize = 0;
        const baseOverhead = 300; // JSON overhead for metadata, conversationId, etc.
        for (const msg of allMessages) {
            const msgSize = JSON.stringify(msg).length;
            if (currentMessages.length > 0 && currentSize + msgSize + baseOverhead > this.maxPayloadSize) {
                payloads.push(this.createPayloadObject(conversationId, currentMessages, files.length));
                currentMessages = [];
                currentSize = 0;
            }
            currentMessages.push(msg);
            currentSize += msgSize;
        }
        if (currentMessages.length > 0) {
            payloads.push(this.createPayloadObject(conversationId, currentMessages, files.length));
        }
        this.logger.debug('Payload built', {
            conversationId,
            payloadCount: payloads.length,
            totalMessages: allMessages.length
        });
        return payloads;
    }
    createPayloadObject(conversationId, messages, fileCount) {
        return {
            conversationId,
            messages,
            metadata: {
                repository: `${this.config.repository.owner}/${this.config.repository.repo}`,
                branch: this.config.repository.branch,
                commit: this.config.repository.sha,
                runId: this.config.repository.runId,
                timestamp: new Date().toISOString(),
                fileCount
            }
        };
    }
    buildProtectionScopesRequest() {
        const request = {
            activities: PayloadBuilder.scopeActivity,
            locations: [
                {
                    "@odata.type": "microsoft.graph.policyLocationDomain",
                    value: `https://${PayloadBuilder.domain}`
                }
            ],
            integratedAppMetadata: {
                name: "Github",
                version: "0.0.1",
            },
        };
        return request;
    }
    buildProcessAndUploadRequests(files, scopeResponse, prInfo) {
        const filesToProcess = [];
        const filesToUpload = [];
        for (const file of files) {
            let shouldProcessFile = false;
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
            }
            else {
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
    checkApplicableScopes(scopes, requestActivity, requestLocation) {
        let shouldProcess = false;
        const dlpActions = [];
        let executionMode = ExecutionMode.evaluateOffline;
        for (const scope of scopes) {
            // Activity match: check if the scope's activity flag covers our request activity
            const activityMatch = this.matchActivity(scope.activities, requestActivity);
            const clientId = this.config.clientId.toLowerCase();
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
                        else if (locDataType.endsWith("policylocationapplication") && loc.value.toLowerCase() === clientId) {
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
        this.logger.info(`Scope check result: shouldProcess=${shouldProcess}, executionMode=${executionMode}, matchingActions=${dlpActions.length}`);
        return { shouldProcess, dlpActions, executionMode };
    }
    /**
     * Build a per-user ProcessContentRequest for inline PC calls.
     */
    buildPerUserProcessContentRequest(file, conversationId, messageId) {
        const content = file.content || `File: ${file.path} (${file.size} bytes)`;
        const singleCTP = this.createContentToProcess(file, conversationId, messageId);
        const singleRequest = { contentToProcess: singleCTP };
        const requestSize = JSON.stringify(singleRequest).length;
        if (requestSize <= this.maxPayloadSize) {
            return [singleRequest];
        }
        // Split content into chunks that fit within maxPayloadSize
        const overhead = requestSize - content.length;
        const maxContentPerChunk = this.maxPayloadSize - overhead - 100; // safety margin
        const requests = [];
        for (let i = 0; i < content.length; i += maxContentPerChunk) {
            const chunk = content.substring(i, Math.min(i + maxContentPerChunk, content.length));
            const isLastChunk = i + maxContentPerChunk >= content.length;
            const chunkCTP = this.createContentToProcess(file, conversationId, messageId + requests.length, !isLastChunk, chunk);
            requests.push({ contentToProcess: chunkCTP });
        }
        this.logger.info(`Split file ${file.path} into ${requests.length} processContent request(s)`);
        return requests;
    }
    matchActivity(scopeActivities, requestActivity) {
        // Map Activity enum to the string used in protection scope responses
        const activityMap = {
            [Activity.uploadText]: "uploadtext",
            [Activity.uploadFile]: "uploadfile",
            [Activity.downloadText]: "downloadtext",
            [Activity.downloadFile]: "downloadfile",
        };
        const expected = activityMap[requestActivity];
        if (!expected)
            return false;
        const scopeStr = (typeof scopeActivities === 'string' ? scopeActivities : '').toLowerCase();
        return scopeStr.includes(expected);
    }
    buildUploadSignalRequest(files, prInfo) {
        const requests = [];
        const conversationId = crypto.randomUUID();
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
                    id: crypto.randomUUID(),
                    userId,
                    userEmail,
                    scopeIdentifier: "",
                    contentMetadata: singleCTP,
                });
                seqNum++;
            }
            else {
                // Split content into chunks
                const overhead = singleSize - content.length;
                const maxContentPerChunk = this.maxPayloadSize - overhead - 100;
                for (let i = 0; i < content.length; i += maxContentPerChunk) {
                    const chunk = content.substring(i, Math.min(i + maxContentPerChunk, content.length));
                    const isLastChunk = i + maxContentPerChunk >= content.length;
                    const chunkCTP = this.createContentToProcess(file, conversationId, seqNum, !isLastChunk, chunk);
                    requests.push({
                        id: crypto.randomUUID(),
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
    buildProcessContentBatchRequest(files) {
        const allItems = [];
        const conversationId = crypto.randomUUID();
        let seqNum = 0;
        for (const file of files) {
            const content = file.content || `File: ${file.path} (${file.size} bytes)`;
            const userId = file.authorId || this.config.userId;
            const singleCTP = this.createContentToProcess(file, conversationId, seqNum);
            const singleItem = {
                contentToProcess: singleCTP,
                userId,
                requestId: crypto.randomUUID(),
            };
            const itemSize = JSON.stringify(singleItem).length;
            if (itemSize <= this.maxPayloadSize) {
                allItems.push(singleItem);
                seqNum++;
            }
            else {
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
        const batches = [];
        let currentItems = [];
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
    createContentToProcess(file, conversationId, messageId, isTruncated = false, contentOverride) {
        let userId = file.authorId;
        if (!userId) {
            this.logger.warn(`No user ID found for file: ${file.path} with author ${file.authorEmail}}, using default user ID`);
            userId = this.config.userId;
        }
        const now = new Date().toISOString();
        let fileContent = {
            "@odata.type": "microsoft.graph.textContent",
            data: contentOverride ?? file.content ?? `File: ${file.path} (${file.size} bytes)`
        };
        return {
            contentEntries: [
                {
                    "@odata.type": "microsoft.graph.processConversationMetadata",
                    identifier: file.path,
                    name: file.path,
                    correlationId: conversationId,
                    sequenceNumber: messageId,
                    length: file.size,
                    isTruncated,
                    createdDateTime: now,
                    modifiedDateTime: now,
                    content: fileContent
                }
            ],
            activityMetadata: {
                activity: Activity.uploadText,
            },
            deviceMetadata: {},
            integratedAppMetadata: {
                name: "Github",
                version: "0.0.1",
            },
            protectedAppMetadata: {
                name: "Github",
                version: "0.0.1",
                applicationLocation: {
                    "@odata.type": "microsoft.graph.policyLocationDomain",
                    value: `https://${PayloadBuilder.domain}`
                }
            }
        };
    }
    createMetadataMessage(files) {
        const summary = {
            totalFiles: files.length,
            totalSize: files.reduce((sum, f) => sum + f.size, 0),
            fileTypes: this.getFileTypes(files),
            repository: this.config.repository
        };
        return {
            id: this.generateMessageId(),
            content: JSON.stringify(summary, null, 2),
            contentType: 'metadata',
            timestamp: new Date().toISOString()
        };
    }
    async createFileMessages(file) {
        const messages = [];
        // If content is included and large, chunk it
        if (file.content && file.content.length > 50000) {
            const chunks = this.chunkContent(file.content);
            for (let i = 0; i < chunks.length; i++) {
                messages.push({
                    id: this.generateMessageId(),
                    content: chunks[i], // Non-null assertion safe due to chunkContent implementation
                    contentType: 'file',
                    timestamp: new Date().toISOString(),
                    fileInfo: {
                        path: file.path,
                        size: file.size,
                        sha: file.sha,
                        language: this.detectLanguage(file.path)
                    }
                });
            }
        }
        else {
            // Single message for small files
            messages.push({
                id: this.generateMessageId(),
                content: file.content || `File: ${file.path} (${file.size} bytes)`,
                contentType: 'file',
                timestamp: new Date().toISOString(),
                fileInfo: {
                    path: file.path,
                    size: file.size,
                    sha: file.sha,
                    language: this.detectLanguage(file.path)
                }
            });
        }
        return messages;
    }
    chunkContent(content, chunkSize = 50000) {
        const chunks = [];
        for (let i = 0; i < content.length; i += chunkSize) {
            chunks.push(content.substring(i, i + chunkSize));
        }
        return chunks;
    }
    generateConversationId() {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 9);
        return `conv-${this.config.repository.runId}-${timestamp}-${random}`;
    }
    generateMessageId() {
        return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }
    getFileTypes(files) {
        const types = {};
        for (const file of files) {
            const ext = file.path.split('.').pop() || 'unknown';
            types[ext] = (types[ext] || 0) + 1;
        }
        return types;
    }
    detectLanguage(filePath) {
        const languageMap = {
            '.js': 'javascript',
            '.ts': 'typescript',
            '.py': 'python',
            '.java': 'java',
            '.cs': 'csharp',
            '.go': 'go',
            '.rs': 'rust',
            '.cpp': 'cpp',
            '.c': 'c',
            '.rb': 'ruby',
            '.php': 'php',
            '.swift': 'swift',
            '.kt': 'kotlin',
            '.scala': 'scala',
            '.r': 'r',
            '.m': 'matlab',
            '.jl': 'julia',
            '.sh': 'shell',
            '.ps1': 'powershell',
            '.yml': 'yaml',
            '.yaml': 'yaml',
            '.json': 'json',
            '.xml': 'xml',
            '.md': 'markdown'
        };
        const ext = filePath.match(/\.[^.]+$/)?.[0];
        return ext ? languageMap[ext] : undefined;
    }
}
//# sourceMappingURL=payloadBuilder.js.map