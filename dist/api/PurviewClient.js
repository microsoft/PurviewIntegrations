import { Logger } from '../utils/logger';
import { RetryHandler } from '../utils/retryHandler';
export class PurviewClient {
    config;
    logger;
    retryHandler;
    authToken = null;
    baseUrl;
    constructor(config) {
        this.config = config;
        this.logger = new Logger('PurviewClient');
        this.retryHandler = new RetryHandler();
        this.baseUrl = `${this.config.purviewEndpoint}`;
    }
    setAuthToken(token) {
        this.authToken = token;
    }
    async queueConversationMessage(payload) {
        if (!this.authToken) {
            throw new Error('Authentication token not set');
        }
        this.logger.info(`Queuing conversation message`);
        const endpoint = `${this.baseUrl}/conversations/${payload.conversationId}/messages`;
        let payloadString = JSON.stringify(payload, this.jsonReplacer);
        try {
            const result = await this.retryHandler.executeWithRetry(async () => this.sendRequest(endpoint, payloadString, 'POST', {}, 'QueueConversationMessage'), 'QueueConversationMessage');
            return result;
        }
        catch (error) {
            this.logger.error('Failed to queue conversation message', { error });
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
    async processContentAsync(payload) {
        if (!this.authToken) {
            throw new Error('Authentication token not set');
        }
        this.logger.info(`Processing content asynchronously.`);
        const endpoint = `${this.baseUrl}/security/dataSecurityAndGovernance/processContentAsync`;
        let payloadString = JSON.stringify(payload, this.jsonReplacer);
        try {
            const result = await this.retryHandler.executeWithRetry(async () => this.sendRequest(endpoint, payloadString, 'POST', {}, 'ProcessContentAsync'), 'ProcessContentAsync');
            return result;
        }
        catch (error) {
            this.logger.error('Failed to process content asynchronously', { error });
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                statusCode: error?.statusCode
            };
        }
    }
    async processContent(userId, request, scopeIdentifier, inline = true) {
        if (!this.authToken) {
            throw new Error('Authentication token not set');
        }
        this.logger.info(`Processing content for user ${userId} (mode: ${inline ? 'inline' : 'offline'})`);
        const endpoint = `${this.baseUrl}/users/${userId}/dataSecurityAndGovernance/processContent`;
        const payloadString = JSON.stringify(request, this.jsonReplacer);
        const additionalHeaders = {};
        if (scopeIdentifier) {
            additionalHeaders['If-None-Match'] = scopeIdentifier;
        }
        if (inline) {
            additionalHeaders['Prefer'] = 'evaluateInline';
        }
        try {
            const result = await this.retryHandler.executeWithRetry(async () => this.sendRequest(endpoint, payloadString, 'POST', additionalHeaders, 'ProcessContent'), 'ProcessContent');
            return result;
        }
        catch (error) {
            this.logger.error(`Failed to process content for user ${userId}`, { error });
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                statusCode: error?.statusCode
            };
        }
    }
    async uploadSignal(payload) {
        if (!this.authToken) {
            throw new Error('Authentication token not set');
        }
        this.logger.info(`Uploading signal for ${payload.contentMetadata.contentEntries[0]?.identifier}`);
        const endpoint = `${this.baseUrl}/users/${payload.userId}/dataSecurityAndGovernance/activities/contentActivities`;
        let payloadString = JSON.stringify(payload, this.jsonReplacer);
        try {
            const result = await this.retryHandler.executeWithRetry(async () => this.sendRequest(endpoint, payloadString, 'POST', {}, 'UploadSignal'), 'UploadSignal');
            return result;
        }
        catch (error) {
            this.logger.error('Failed to upload signal', { error });
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
    async searchTenantProtectionScope(payload) {
        if (!this.authToken) {
            throw new Error('Authentication token not set');
        }
        this.logger.info(`Searching tenant protection scope`);
        const endpoint = `${this.baseUrl}/security/dataSecurityAndGovernance/protectionScopes/compute`;
        let payloadString = JSON.stringify(payload, this.jsonReplacer);
        try {
            const result = await this.retryHandler.executeWithRetry(async () => this.sendRequest(endpoint, payloadString, 'POST', {}, 'SearchTenantProtectionScope'), 'SearchTenantProtectionScope');
            const scopeCount = result.data?.value?.length ?? 0;
            this.logger.info(`[SearchTenantProtectionScope] Returned ${scopeCount} scope(s)`);
            return result;
        }
        catch (error) {
            this.logger.error('Failed to search tenant protection scope', { error });
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                statusCode: error?.statusCode
            };
        }
    }
    async searchUserProtectionScope(userId, payload) {
        if (!this.authToken) {
            throw new Error('Authentication token not set');
        }
        this.logger.info(`Searching protection scope for user ${userId}`);
        const endpoint = `${this.baseUrl}/users/${userId}/dataSecurityAndGovernance/protectionScopes/compute`;
        let payloadString = JSON.stringify(payload, this.jsonReplacer);
        try {
            const result = await this.retryHandler.executeWithRetry(async () => this.sendRequest(endpoint, payloadString, 'POST', {}, 'SearchUserProtectionScope'), 'SearchUserProtectionScope');
            const scopeCount = result.data?.value?.length ?? 0;
            this.logger.info(`[SearchUserProtectionScope] Returned ${scopeCount} scope(s) for user ${userId}`);
            return result;
        }
        catch (error) {
            this.logger.error(`Failed to search protection scope for user ${userId}`, { error });
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                statusCode: error?.statusCode
            };
        }
    }
    async getUserInfo(userEmails) {
        if (!this.authToken) {
            throw new Error('Authentication token not set');
        }
        this.logger.info(`Getting user info for ${userEmails.length} users`);
        let usernameFilter = userEmails.map(email => `userPrincipalName eq '${email}'`).join(' OR ');
        const endpoint = `${this.baseUrl}/users/?$select=id,userPrincipalName&$filter=${usernameFilter}`;
        try {
            const result = await this.retryHandler.executeWithRetry(async () => this.sendRequest(endpoint, null, 'GET', {}, 'GetUserInfo'), 'GetUserInfo');
            this.logger.info(`Received user info for ${result.data?.value.length} users`);
            return result;
        }
        catch (error) {
            this.logger.error('Failed to get user info', { error });
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
    async sendRequest(endpoint, payload = null, method = "POST", additionalHeaders = {}, operationName = 'Unknown') {
        const headers = {
            'Authorization': `Bearer ${this.authToken}`,
            'Content-Type': 'application/json',
            'X-Request-Id': this.generateRequestId(),
            'User-Agent': 'PurviewGitHubAction/1.0',
            ...additionalHeaders
        };
        this.logger.startGroup('Purview API Request');
        this.logger.debug('Sending request', {
            endpoint,
            payloadSize: JSON.stringify(payload).length
        });
        try {
            const response = await fetch(endpoint, {
                method: method,
                headers,
                body: payload
            });
            const responseText = await response.text();
            const requestId = response.headers.get('client-request-id');
            this.logger.info(`[${operationName}] Received response with status: ${response.status}, correlation ID: ${requestId}`);
            if (!response.ok) {
                this.logger.error('API request failed', {
                    status: response.status,
                    statusText: response.statusText,
                    correlationId: requestId,
                    response: this.sanitizeErrorResponse(responseText)
                });
                // Handle specific error cases
                if (response.status === 401) {
                    const err = new Error('Authentication failed. Token may be expired.');
                    err.statusCode = 401;
                    throw err;
                }
                if (response.status === 429) {
                    const retryAfter = response.headers.get('Retry-After');
                    throw new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
                }
                const err = new Error(`API request failed: ${response.status} - ${response.statusText}`);
                err.statusCode = response.status;
                throw err;
            }
            try {
                const data = responseText ? JSON.parse(responseText) : {};
                const etag = response.headers.get('etag')?.replace(/"/g, '') || undefined;
                this.logger.endGroup();
                return {
                    success: true,
                    data,
                    statusCode: response.status,
                    etag
                };
            }
            catch (parseError) {
                const sanitizedErrorResponse = this.sanitizeErrorResponse(responseText);
                this.logger.warn('Failed to parse response', { parseError, sanitizedErrorResponse });
                this.logger.endGroup();
                return {
                    success: false,
                    statusCode: response.status
                };
            }
        }
        catch (error) {
            this.logger.endGroup();
            throw error;
        }
    }
    jsonReplacer(_key, value) {
        // Remove sensitive data from logs
        if (typeof value === 'string' && value.length > 1000) {
            return value.substring(0, 100) + '... [truncated in logs]';
        }
        return value;
    }
    generateRequestId() {
        return `${this.config.repository.runId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    sanitizeErrorResponse(response) {
        // Remove any potential sensitive data from error responses
        const sanitized = response
            .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
            .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '[GUID]');
        return sanitized.substring(0, 500); // Limit length
    }
}
//# sourceMappingURL=purviewClient.js.map