import { ActionConfig, ApiResponse, ProcessContentBatchRequest, ProcessContentRequest, ProcessContentResponse, UploadSignalRequest, ProtectionScopesRequest, ProtectionScopesResponse, GraphUserInfoContainer } from '../config/types';
import { Logger } from '../utils/logger';
import { RetryHandler } from '../utils/retryHandler';

export class PurviewClient {
  private readonly logger: Logger;
  private readonly retryHandler: RetryHandler;
  private authToken: string | null = null;
  private tokenProvider: (() => Promise<string>) | null = null;
  private readonly baseUrl: string;
  
  constructor(private readonly config: ActionConfig) {
    this.logger = new Logger('PurviewClient');
    this.retryHandler = new RetryHandler();
    this.baseUrl = `${this.config.purviewEndpoint}`;
  }
  
  setAuthToken(token: string): void {
    this.authToken = token;
  }

  /**
   * Set a callback that returns a fresh access token.  When set, the provider
   * is called before every request (it should cache internally) and again
   * after a 401 to attempt a single token-refresh retry.
   */
  setTokenProvider(provider: () => Promise<string>): void {
    this.tokenProvider = provider;
  }

  private async resolveAuthToken(): Promise<string> {
    if (this.tokenProvider) {
      return await this.tokenProvider();
    }
    if (this.authToken) {
      return this.authToken;
    }
    throw new Error('Authentication token not set');
  }

  async processContentAsync(payload: ProcessContentBatchRequest): Promise<ApiResponse> {
    if (!this.authToken) {
      throw new Error('Authentication token not set');
    }

    this.logger.info(`Processing content asynchronously.`);

    const endpoint = `${this.baseUrl}/security/dataSecurityAndGovernance/processContentAsync`;
    let payloadString: string = JSON.stringify(payload, this.jsonReplacer);

    try {
      const result = await this.retryHandler.executeWithRetry(
        async () => this.sendRequest(endpoint, payloadString, 'POST', {}, 'ProcessContentAsync'),
        'ProcessContentAsync'
      );
      
      return result;
    } catch (error) {
      this.logger.error('Failed to process content asynchronously', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        statusCode: (error as any)?.statusCode
      };
    }
  }

  async processContent(userId: string, request: ProcessContentRequest, scopeIdentifier: string, inline: boolean = true): Promise<ApiResponse<ProcessContentResponse>> {
    if (!this.authToken) {
      throw new Error('Authentication token not set');
    }

    this.logger.info(`Processing content for user ${userId} (mode: ${inline ? 'inline' : 'offline'})`);

    const endpoint = `${this.baseUrl}/users/${userId}/dataSecurityAndGovernance/processContent`;
    const payloadString: string = JSON.stringify(request, this.jsonReplacer);

    const additionalHeaders: Record<string, string> = {};
    if (scopeIdentifier) {
      additionalHeaders['If-None-Match'] = scopeIdentifier;
    }
    if (inline) {
      additionalHeaders['Prefer'] = 'evaluateInline';
    }

    try {
      const result = await this.retryHandler.executeWithRetry(
        async () => this.sendRequest(endpoint, payloadString, 'POST', additionalHeaders, 'ProcessContent'),
        'ProcessContent'
      );

      return result;
    } catch (error) {
      this.logger.error(`Failed to process content for user ${userId}`, { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        statusCode: (error as any)?.statusCode
      };
    }
  }

  async uploadSignal(payload: UploadSignalRequest): Promise<ApiResponse> {
    if (!this.authToken) {
      throw new Error('Authentication token not set');
    }

    this.logger.info(`Uploading signal for ${payload.contentMetadata.contentEntries[0]?.identifier}`);

    const endpoint = `${this.baseUrl}/users/${payload.userId}/dataSecurityAndGovernance/activities/contentActivities`;
    let payloadString: string = JSON.stringify(payload, this.jsonReplacer);

    try {
      const result = await this.retryHandler.executeWithRetry(
        async () => this.sendRequest(endpoint, payloadString, 'POST', {}, 'UploadSignal'),
        'UploadSignal'
      );

      return result;
    } catch (error) {
      this.logger.error('Failed to upload signal', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async searchTenantProtectionScope(payload: ProtectionScopesRequest): Promise<ApiResponse<ProtectionScopesResponse>> {
    if (!this.authToken) {
      throw new Error('Authentication token not set');
    }

    this.logger.info(`Searching tenant protection scope`);

    const endpoint = `${this.baseUrl}/security/dataSecurityAndGovernance/protectionScopes/compute`;
    let payloadString: string = JSON.stringify(payload, this.jsonReplacer);

    try {
      const result = await this.retryHandler.executeWithRetry(
        async () => this.sendRequest(endpoint, payloadString, 'POST', {}, 'SearchTenantProtectionScope'),
        'SearchTenantProtectionScope'
      );

      const scopeCount = result.data?.value?.length ?? 0;
      this.logger.info(`[SearchTenantProtectionScope] Returned ${scopeCount} scope(s)`);

      return result;
    } catch (error) {
      this.logger.error('Failed to search tenant protection scope', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        statusCode: (error as any)?.statusCode
      };
    }
  }

  async searchUserProtectionScope(userId: string, payload: ProtectionScopesRequest): Promise<ApiResponse<ProtectionScopesResponse>> {
    if (!this.authToken) {
      throw new Error('Authentication token not set');
    }

    this.logger.info(`Searching protection scope for user ${userId}`);

    const endpoint = `${this.baseUrl}/users/${userId}/dataSecurityAndGovernance/protectionScopes/compute`;
    let payloadString: string = JSON.stringify(payload, this.jsonReplacer);

    try {
      const result = await this.retryHandler.executeWithRetry(
        async () => this.sendRequest(endpoint, payloadString, 'POST', {}, 'SearchUserProtectionScope'),
        'SearchUserProtectionScope'
      );

      const scopeCount = result.data?.value?.length ?? 0;
      this.logger.info(`[SearchUserProtectionScope] Returned ${scopeCount} scope(s) for user ${userId}`);

      return result;
    } catch (error) {
      this.logger.error(`Failed to search protection scope for user ${userId}`, { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        statusCode: (error as any)?.statusCode
      };
    }
  }

  async getUserInfo(userEmails: string[]): Promise<ApiResponse<GraphUserInfoContainer>> {
    if (!this.authToken) {
      throw new Error('Authentication token not set');
    }

    this.logger.info(`Getting user info for ${userEmails.length} users`);

    let usernameFilter = userEmails.map(email => `userPrincipalName eq '${email}'`).join(' OR ');

    const endpoint = `${this.baseUrl}/users/?$select=id,userPrincipalName&$filter=${usernameFilter}`;

    try {
      const result: ApiResponse<GraphUserInfoContainer> = await this.retryHandler.executeWithRetry(
        async () => this.sendRequest(endpoint, null, 'GET', {}, 'GetUserInfo'),
        'GetUserInfo'
      );

      this.logger.info(`Received user info for ${result.data?.value.length} users`);

      return result;
    } catch (error) {
      this.logger.error('Failed to get user info', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async sendRequest(endpoint: string, payload: string | null = null, method: string = "POST", additionalHeaders: Record<string, string> = {}, operationName: string = 'Unknown'): Promise<ApiResponse> {
    return this.sendRequestInner(endpoint, payload, method, additionalHeaders, operationName, true);
  }

  private async sendRequestInner(endpoint: string, payload: string | null, method: string, additionalHeaders: Record<string, string>, operationName: string, allowAuthRetry: boolean): Promise<ApiResponse> {
    const currentToken = await this.resolveAuthToken();
    const requestId = this.generateRequestId();
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${currentToken}`,
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
      'User-Agent': 'PurviewGitHubAction/1.0',
      ...additionalHeaders
    };
    
    this.logger.startGroup('Purview API Request');
    this.logger.debug(`[${operationName}] Request`, { 
      endpoint: this.sanitizeEndpoint(endpoint),
      method,
      requestId,
      additionalHeaders: Object.keys(additionalHeaders),
    });
    if (payload) {
      this.logger.debug(`[${operationName}] Request payload`, {
        payload: JSON.parse(JSON.stringify(JSON.parse(payload), this.jsonReplacer)),
      });
    }
    
    try {
      const response = await fetch(endpoint, {
        method: method,
        headers,
        body: payload
      });
      
      const responseText = await response.text();
      const correlationId: string | null = response.headers.get('client-request-id');
      this.logger.info(`[${operationName}] Received response with status: ${response.status}, correlation ID: ${correlationId}`);
      
      if (!response.ok) {
        this.logger.debug(`[${operationName}] Error response body`, {
          status: response.status,
          correlationId,
          body: this.sanitizeErrorResponse(responseText),
        });
        this.logger.error('API request failed', {
          status: response.status,
          statusText: response.statusText,
          correlationId,
          response: this.sanitizeErrorResponse(responseText)
        });
        
        // Handle specific error cases
        if (response.status === 401) {
          // If we have a token provider, clear the stale token and retry once
          if (allowAuthRetry && this.tokenProvider) {
            this.logger.info(`[${operationName}] 401 received — refreshing token and retrying`);
            this.logger.endGroup();
            return this.sendRequestInner(endpoint, payload, method, additionalHeaders, operationName, false);
          }
          const err = new Error('Authentication failed. Token may be expired.');
          (err as any).statusCode = 401;
          throw err;
        }
        
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          throw new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
        }
        
        const err = new Error(`API request failed: ${response.status} - ${response.statusText}`);
        (err as any).statusCode = response.status;
        throw err;
      }
      
      try {
        const data = responseText ? JSON.parse(responseText) : {};
        const etag = response.headers.get('etag')?.replace(/"/g, '') || undefined;
        this.logger.debug(`[${operationName}] Response payload`, {
          statusCode: response.status,
          etag,
          correlationId,
          data: JSON.parse(JSON.stringify(data, this.jsonReplacer)),
        });
        this.logger.endGroup();
        return {
          success: true,
          data,
          statusCode: response.status,
          etag
        };
      } catch (parseError) {
        const sanitizedErrorResponse = this.sanitizeErrorResponse(responseText);
        this.logger.warn('Failed to parse response', { parseError, sanitizedErrorResponse });
        this.logger.endGroup();
        return {
          success: false,
          statusCode: response.status
        };
      }
    } catch (error) {
      this.logger.endGroup();
      throw error;
    }
  }
  
  private jsonReplacer(_key: string, value: any): any {
    // Remove sensitive data from logs
    if (typeof value === 'string' && value.length > 1000) {
      return value.substring(0, 100) + '... [truncated in logs]';
    }
    return value;
  }
  
  private generateRequestId(): string {
    return `${this.config.repository.runId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private sanitizeEndpoint(endpoint: string): string {
    return endpoint.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '<guid>');
  }
  
  private sanitizeErrorResponse(response: string): string {
    // Remove any potential sensitive data from error responses
    const sanitized = response
      .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
      .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '[GUID]');
    
    return sanitized.substring(0, 500); // Limit length
  }

}