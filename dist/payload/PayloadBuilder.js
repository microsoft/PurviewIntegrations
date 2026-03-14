import { Activity, ExecutionMode } from '../config/types';
import { Logger } from '../utils/logger';
export class PayloadBuilder {
    config;
    logger;
    maxPayloadSize = 1024 * 1024 * 5; // 5MB
    static domain = "github.com";
    static scopeActivity = "uploadText";
    constructor(config) {
        this.config = config;
        this.logger = new Logger('PayloadBuilder');
    }
    async build(files) {
        const conversationId = this.generateConversationId();
        const messages = [];
        // Add metadata message
        messages.push(this.createMetadataMessage(files));
        // Add file messages
        for (const file of files) {
            const fileMessages = await this.createFileMessages(file);
            messages.push(...fileMessages);
        }
        const payload = {
            conversationId,
            messages,
            metadata: {
                repository: `${this.config.repository.owner}/${this.config.repository.repo}`,
                branch: this.config.repository.branch,
                commit: this.config.repository.sha,
                runId: this.config.repository.runId,
                timestamp: new Date().toISOString(),
                fileCount: files.length
            }
        };
        // Validate payload size
        const payloadSize = JSON.stringify(payload).length;
        if (payloadSize > this.maxPayloadSize) {
            this.logger.warn('Payload too large, truncating content', { size: payloadSize });
            return this.truncatePayload(payload);
        }
        this.logger.debug('Payload built', {
            conversationId,
            messageCount: messages.length,
            size: payloadSize
        });
        return payload;
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
        const pcbRequest = filesToProcess.length > 0 ? this.buildProcessContentBatchRequest(filesToProcess) : undefined;
        return {
            uploadSignalRequests: uploadSignalRequests,
            processContentRequest: pcbRequest
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
        const contentToProcess = this.createContentToProcess(file, conversationId, messageId);
        return { contentToProcess };
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
        let requests = [];
        let conversationId = crypto.randomUUID();
        files.forEach((file, index) => {
            this.logger.info(`Building upload signal request for file: ${file.path}`);
            const contentToProcess = this.createContentToProcess(file, conversationId, index);
            const userId = file.authorId || this.config.userId;
            const signalRequest = {
                id: crypto.randomUUID(),
                userId: userId,
                userEmail: file.authorEmail || prInfo.authorEmail,
                scopeIdentifier: "",
                contentMetadata: contentToProcess,
            };
            requests.push(signalRequest);
        });
        return requests;
    }
    buildProcessContentBatchRequest(files) {
        const items = [];
        const conversationId = crypto.randomUUID();
        files.forEach((file, index) => {
            const contentToProcess = this.createContentToProcess(file, conversationId, index);
            items.push({
                contentToProcess: contentToProcess,
                userId: file.authorId || this.config.userId,
                requestId: crypto.randomUUID(),
            });
        });
        return { processContentRequests: items };
    }
    createContentToProcess(file, conversationId, messageId) {
        let userId = file.authorId;
        if (!userId) {
            this.logger.warn(`No user ID found for file: ${file.path} with author ${file.authorEmail}}, using default user ID`);
            userId = this.config.userId;
        }
        const now = new Date().toISOString();
        let fileContent = {
            "@odata.type": "microsoft.graph.textContent",
            data: file.content || `File: ${file.path} (${file.size} bytes)`
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
                    isTruncated: false,
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
    truncatePayload(payload) {
        // Remove content from file messages to reduce size
        const truncated = { ...payload };
        truncated.messages = truncated.messages.map(msg => {
            if (msg.contentType === 'file' && msg.content.length > 1000) {
                return {
                    ...msg,
                    content: msg.content.substring(0, 1000) + '... [truncated]'
                };
            }
            return msg;
        });
        return truncated;
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