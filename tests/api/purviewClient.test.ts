jest.mock('@actions/core', () => ({
  getBooleanInput: jest.fn().mockReturnValue(false),
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
}));

import { PurviewClient } from '../../src/api/purviewClient';
import { ActionConfig, ProcessContentBatchRequest, UploadSignalRequest } from '../../src/config/types';

function createConfig(overrides: Partial<ActionConfig> = {}): ActionConfig {
  return {
    clientId: '11111111-1111-1111-1111-111111111111',
    tenantId: '22222222-2222-2222-2222-222222222222',
    purviewAccountName: 'test-account',
    purviewEndpoint: 'https://graph.microsoft.com/v1.0',
    filePatterns: ['**'],
    maxFileSize: 10485760,
    debug: false,
    userId: 'default-user-id',
    repository: {
      owner: 'testOwner',
      repo: 'testRepo',
      branch: 'main',
      sha: 'abc123',
      runId: '999',
      runNumber: '1',
    },
    ...overrides,
  };
}

describe('PurviewClient', () => {
  let client: PurviewClient;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    client = new PurviewClient(createConfig());
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(response: { status: number; body?: any; headers?: Record<string, string> }) {
    const headers = new Map(Object.entries(response.headers ?? {}));
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.status === 200 ? 'OK' : 'Error',
      text: jest.fn().mockResolvedValue(JSON.stringify(response.body ?? {})),
      headers: {
        get: (key: string) => headers.get(key.toLowerCase()) ?? null,
      },
    });
  }

  describe('setAuthToken', () => {
    it('allows API calls after setting token', async () => {
      client.setAuthToken('test-token');
      mockFetch({ status: 200, body: { value: [] } });

      const result = await client.searchTenantProtectionScope({
        activities: 'uploadText',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('processContentAsync', () => {
    it('throws when auth token is not set', async () => {
      const payload: ProcessContentBatchRequest = { processContentRequests: [] };
      await expect(client.processContentAsync(payload)).rejects.toThrow(
        'Authentication token not set'
      );
    });

    it('returns success on 200 response', async () => {
      client.setAuthToken('token');
      mockFetch({ status: 200, body: { id: 'batch-1' } });

      const result = await client.processContentAsync({ processContentRequests: [] });
      expect(result.success).toBe(true);
    });
  });

  describe('processContent', () => {
    it('throws when auth token is not set', async () => {
      await expect(
        client.processContent('user-1', { contentToProcess: { contentEntries: [] } as any }, '')
      ).rejects.toThrow('Authentication token not set');
    });

    it('sends request to user-specific endpoint', async () => {
      client.setAuthToken('token');
      mockFetch({ status: 200, body: { id: 'pc-1', policyActions: [] } });

      await client.processContent(
        'user-abc',
        { contentToProcess: { contentEntries: [] } as any },
        'scope-id',
        true
      );

      const callUrl = (globalThis.fetch as jest.Mock).mock.calls[0][0];
      expect(callUrl).toContain('/users/user-abc/dataSecurityAndGovernance/processContent');
    });

    it('adds If-None-Match header when scopeIdentifier is provided', async () => {
      client.setAuthToken('token');
      mockFetch({ status: 200, body: {} });

      await client.processContent(
        'user-1',
        { contentToProcess: { contentEntries: [] } as any },
        'etag-value'
      );

      const callHeaders = (globalThis.fetch as jest.Mock).mock.calls[0][1].headers;
      expect(callHeaders['If-None-Match']).toBe('etag-value');
    });

    it('adds Prefer header for inline mode', async () => {
      client.setAuthToken('token');
      mockFetch({ status: 200, body: {} });

      await client.processContent(
        'user-1',
        { contentToProcess: { contentEntries: [] } as any },
        '',
        true
      );

      const callHeaders = (globalThis.fetch as jest.Mock).mock.calls[0][1].headers;
      expect(callHeaders['Prefer']).toBe('evaluateInline');
    });
  });

  describe('uploadSignal', () => {
    it('throws when auth token is not set', async () => {
      const payload: UploadSignalRequest = {
        id: 'sig-1',
        userId: 'u1',
        scopeIdentifier: '',
        contentMetadata: {
          contentEntries: [{ identifier: 'test.ts' }],
        } as any,
      };
      await expect(client.uploadSignal(payload)).rejects.toThrow(
        'Authentication token not set'
      );
    });

    it('sends to contentActivities endpoint', async () => {
      client.setAuthToken('token');
      mockFetch({ status: 200, body: {} });

      const payload: UploadSignalRequest = {
        id: 'sig-1',
        userId: 'user-xyz',
        scopeIdentifier: '',
        contentMetadata: {
          contentEntries: [{ identifier: 'test.ts' }],
        } as any,
      };

      await client.uploadSignal(payload);
      const callUrl = (globalThis.fetch as jest.Mock).mock.calls[0][0];
      expect(callUrl).toContain('/users/user-xyz/dataSecurityAndGovernance/activities/contentActivities');
    });
  });

  describe('searchTenantProtectionScope', () => {
    it('sends to tenant protection scope endpoint', async () => {
      client.setAuthToken('token');
      mockFetch({ status: 200, body: { value: [] } });

      await client.searchTenantProtectionScope({ activities: 'uploadText' });
      const callUrl = (globalThis.fetch as jest.Mock).mock.calls[0][0];
      expect(callUrl).toContain('/security/dataSecurityAndGovernance/protectionScopes/compute');
    });
  });

  describe('searchUserProtectionScope', () => {
    it('sends to user protection scope endpoint', async () => {
      client.setAuthToken('token');
      mockFetch({ status: 200, body: { value: [] } });

      await client.searchUserProtectionScope('user-1', { activities: 'uploadText' });
      const callUrl = (globalThis.fetch as jest.Mock).mock.calls[0][0];
      expect(callUrl).toContain('/users/user-1/dataSecurityAndGovernance/protectionScopes/compute');
    });
  });

  describe('getUserInfo', () => {
    it('throws when auth token is not set', async () => {
      await expect(client.getUserInfo(['test@test.com'])).rejects.toThrow(
        'Authentication token not set'
      );
    });

    it('sends GET request with filter query', async () => {
      client.setAuthToken('token');
      mockFetch({
        status: 200,
        body: { value: [{ id: 'u1', userPrincipalName: 'test@test.com' }] },
      });

      const result = await client.getUserInfo(['test@test.com']);
      expect(result.success).toBe(true);

      const callUrl = (globalThis.fetch as jest.Mock).mock.calls[0][0];
      expect(callUrl).toContain('/users/');
      expect(callUrl).toContain('userPrincipalName');
    });
  });

  describe('error handling', () => {
    it('returns success=false on non-retryable errors', async () => {
      client.setAuthToken('token');
      mockFetch({ status: 400, body: { error: 'Bad Request' } });

      // processContentAsync catches errors and returns { success: false }
      const result = await client.processContentAsync({ processContentRequests: [] });
      expect(result.success).toBe(false);
    });

    it('includes etag from response headers', async () => {
      client.setAuthToken('token');
      mockFetch({
        status: 200,
        body: { value: [] },
        headers: { etag: '"abc-123"' },
      });

      const result = await client.searchTenantProtectionScope({ activities: 'uploadText' });
      expect(result.success).toBe(true);
      expect(result.etag).toBe('abc-123');
    });
  });
});
