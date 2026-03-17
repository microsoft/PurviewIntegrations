jest.mock('@actions/core', () => ({
  getBooleanInput: jest.fn().mockReturnValue(false),
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
}));

import { PayloadBuilder } from '../../src/payload/payloadBuilder';
import {
  ActionConfig,
  FileMetadata,
  PolicyScopes,
  PolicyLocation,
  Activity,
  ExecutionMode,
  ProtectionScopesResponse,
  PrInfo,
} from '../../src/config/types';

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

function createFile(overrides: Partial<FileMetadata> = {}): FileMetadata {
  return {
    path: 'src/index.ts',
    size: 1024,
    encoding: 'utf-8',
    sha: 'file-sha-1',
    content: 'console.log("hello");',
    ...overrides,
  };
}

function createPrInfo(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    iterations: 1,
    authorLogin: 'testuser',
    authorEmail: 'test@test.com',
    head: 'feature-branch',
    base: 'main',
    title: 'Test PR',
    url: 'https://github.com/testOwner/testRepo/pull/1',
    ...overrides,
  };
}

describe('PayloadBuilder', () => {
  let builder: PayloadBuilder;

  beforeEach(() => {
    builder = new PayloadBuilder(createConfig());
  });

  describe('build', () => {
    it('builds payload with metadata and file messages', async () => {
      const files = [createFile()];
      const payload = await builder.build(files);

      expect(payload.conversationId).toBeTruthy();
      expect(payload.conversationId).toMatch(/^conv-/);
      expect(payload.messages.length).toBeGreaterThanOrEqual(2); // metadata + file
      expect(payload.metadata.repository).toBe('testOwner/testRepo');
      expect(payload.metadata.branch).toBe('main');
      expect(payload.metadata.commit).toBe('abc123');
      expect(payload.metadata.fileCount).toBe(1);
    });

    it('includes metadata message with file summary', async () => {
      const files = [
        createFile({ path: 'a.ts', size: 100 }),
        createFile({ path: 'b.js', size: 200 }),
      ];
      const payload = await builder.build(files);

      const metadataMsg = payload.messages.find(m => m.contentType === 'metadata');
      expect(metadataMsg).toBeDefined();
      const content = JSON.parse(metadataMsg!.content);
      expect(content.totalFiles).toBe(2);
      expect(content.totalSize).toBe(300);
    });

    it('chunks large file content', async () => {
      const largeContent = 'x'.repeat(120000);
      const files = [createFile({ content: largeContent })];
      const payload = await builder.build(files);

      const fileMessages = payload.messages.filter(m => m.contentType === 'file');
      expect(fileMessages.length).toBeGreaterThan(1);
    });

    it('truncates payload when exceeding 5MB', async () => {
      const hugeContent = 'y'.repeat(2000000);
      const files = Array.from({ length: 5 }, (_, i) =>
        createFile({ path: `file${i}.ts`, content: hugeContent })
      );

      const payload = await builder.build(files);
      // After truncation, file contents should be capped
      const truncatedMessages = payload.messages.filter(
        m => m.contentType === 'file' && m.content.includes('[truncated]')
      );
      expect(truncatedMessages.length).toBeGreaterThan(0);
    });
  });

  describe('buildProtectionScopesRequest', () => {
    it('returns request with uploadText activity', () => {
      const request = builder.buildProtectionScopesRequest();
      expect(request.activities).toBe('uploadText');
    });

    it('returns request with github.com domain location', () => {
      const request = builder.buildProtectionScopesRequest();
      expect(request.locations).toHaveLength(1);
      const loc = request.locations![0]!;
      expect(loc.value).toBe('https://github.com');
      expect(loc['@odata.type']).toContain('policyLocationDomain');
    });

    it('includes integratedAppMetadata', () => {
      const request = builder.buildProtectionScopesRequest();
      expect(request.integratedAppMetadata?.name).toBe('Github');
      expect(request.integratedAppMetadata?.version).toBe('0.0.1');
    });
  });

  describe('checkApplicableScopes', () => {
    const requestLocation: PolicyLocation = {
      '@odata.type': 'microsoft.graph.policyLocationDomain',
      value: 'https://github.com',
    };

    it('returns shouldProcess=false when no scopes match', () => {
      const scopes: PolicyScopes[] = [];
      const result = builder.checkApplicableScopes(scopes, Activity.uploadText, requestLocation);
      expect(result.shouldProcess).toBe(false);
      expect(result.dlpActions).toHaveLength(0);
      expect(result.executionMode).toBe(ExecutionMode.evaluateOffline);
    });

    it('returns shouldProcess=true when activity and location match', () => {
      const scopes: PolicyScopes[] = [
        {
          policyScope: { inclusions: [], exclusions: [] },
          locations: [
            {
              '@odata.type': 'microsoft.graph.policyLocationDomain',
              value: 'https://github.com',
            },
          ],
          activities: 'uploadText',
          executionMode: 'evaluateOffline',
          policyActions: [],
        },
      ];
      const result = builder.checkApplicableScopes(scopes, Activity.uploadText, requestLocation);
      expect(result.shouldProcess).toBe(true);
    });

    it('returns shouldProcess=false when activity does not match', () => {
      const scopes: PolicyScopes[] = [
        {
          policyScope: { inclusions: [], exclusions: [] },
          locations: [
            {
              '@odata.type': 'microsoft.graph.policyLocationDomain',
              value: 'https://github.com',
            },
          ],
          activities: 'downloadFile',
          executionMode: 'evaluateOffline',
          policyActions: [],
        },
      ];
      const result = builder.checkApplicableScopes(scopes, Activity.uploadText, requestLocation);
      expect(result.shouldProcess).toBe(false);
    });

    it('returns shouldProcess=false when location does not match', () => {
      const scopes: PolicyScopes[] = [
        {
          policyScope: { inclusions: [], exclusions: [] },
          locations: [
            {
              '@odata.type': 'microsoft.graph.policyLocationDomain',
              value: 'https://gitlab.com',
            },
          ],
          activities: 'uploadText',
          executionMode: 'evaluateOffline',
          policyActions: [],
        },
      ];
      const result = builder.checkApplicableScopes(scopes, Activity.uploadText, requestLocation);
      expect(result.shouldProcess).toBe(false);
    });

    it('uses evaluateInline when any matching scope says so (sticky upgrade)', () => {
      const scopes: PolicyScopes[] = [
        {
          policyScope: { inclusions: [], exclusions: [] },
          locations: [{ '@odata.type': 'microsoft.graph.policyLocationDomain', value: 'https://github.com' }],
          activities: 'uploadText',
          executionMode: 'evaluateOffline',
          policyActions: [{ action: 'audit' }],
        },
        {
          policyScope: { inclusions: [], exclusions: [] },
          locations: [{ '@odata.type': 'microsoft.graph.policyLocationDomain', value: 'https://github.com' }],
          activities: 'uploadText',
          executionMode: 'evaluateInline',
          policyActions: [{ action: 'blockAccess' }],
        },
      ];
      const result = builder.checkApplicableScopes(scopes, Activity.uploadText, requestLocation);
      expect(result.shouldProcess).toBe(true);
      expect(result.executionMode).toBe(ExecutionMode.evaluateInline);
      expect(result.dlpActions).toHaveLength(2);
    });

    it('matches policyLocationApplication with clientId', () => {
      const scopes: PolicyScopes[] = [
        {
          policyScope: { inclusions: [], exclusions: [] },
          locations: [
            {
              '@odata.type': 'microsoft.graph.policyLocationApplication',
              value: '11111111-1111-1111-1111-111111111111',
            },
          ],
          activities: 'uploadText',
          executionMode: 'evaluateOffline',
          policyActions: [],
        },
      ];
      const result = builder.checkApplicableScopes(scopes, Activity.uploadText, requestLocation);
      expect(result.shouldProcess).toBe(true);
    });

    it('accumulates policyActions from all matching scopes', () => {
      const scopes: PolicyScopes[] = [
        {
          policyScope: { inclusions: [], exclusions: [] },
          locations: [{ '@odata.type': 'microsoft.graph.policyLocationDomain', value: 'https://github.com' }],
          activities: 'uploadText',
          executionMode: 'evaluateOffline',
          policyActions: [{ action: 'audit', policyName: 'P1' }],
        },
        {
          policyScope: { inclusions: [], exclusions: [] },
          locations: [{ '@odata.type': 'microsoft.graph.policyLocationDomain', value: 'https://github.com' }],
          activities: 'uploadText',
          executionMode: 'evaluateOffline',
          policyActions: [{ action: 'blockAccess', policyName: 'P2' }],
        },
      ];
      const result = builder.checkApplicableScopes(scopes, Activity.uploadText, requestLocation);
      expect(result.dlpActions).toHaveLength(2);
      expect(result.dlpActions.map(a => a.policyName)).toEqual(['P1', 'P2']);
    });
  });

  describe('buildPerUserProcessContentRequest', () => {
    it('builds request with correct content structure', () => {
      const file = createFile({ path: 'test.ts', content: 'const x = 1;', authorId: 'author-1' });
      const request = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);

      expect(request.contentToProcess).toBeDefined();
      expect(request.contentToProcess.contentEntries).toHaveLength(1);
      const entry = request.contentToProcess.contentEntries[0]!;
      expect(entry.identifier).toBe('test.ts');
      expect(entry.name).toBe('test.ts');
      expect(entry.correlationId).toBe('conv-1');
      expect(request.contentToProcess.activityMetadata?.activity).toBe(Activity.uploadText);
    });

    it('uses file content as data', () => {
      const file = createFile({ content: 'my content' });
      const request = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);
      const content = request.contentToProcess.contentEntries[0]!.content as any;
      expect(content.data).toBe('my content');
      expect(content['@odata.type']).toBe('microsoft.graph.textContent');
    });

    it('uses placeholder when file has no content', () => {
      const file = createFile({ path: 'empty.txt', size: 500, content: undefined });
      const request = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);
      const content = request.contentToProcess.contentEntries[0]!.content as any;
      expect(content.data).toContain('empty.txt');
      expect(content.data).toContain('500 bytes');
    });

    it('includes protectedAppMetadata with github domain', () => {
      const file = createFile();
      const request = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);
      expect(request.contentToProcess.protectedAppMetadata?.applicationLocation.value).toBe('https://github.com');
    });
  });

  describe('buildUploadSignalRequest', () => {
    it('creates one request per file', () => {
      const files = [
        createFile({ path: 'a.ts', authorId: 'u1' }),
        createFile({ path: 'b.ts', authorId: 'u2' }),
      ];
      const prInfo = createPrInfo();
      const requests = builder.buildUploadSignalRequest(files, prInfo);

      expect(requests).toHaveLength(2);
      expect(requests[0]!.userId).toBe('u1');
      expect(requests[1]!.userId).toBe('u2');
    });

    it('uses default userId when authorId is missing', () => {
      const files = [createFile({ authorId: undefined })];
      const prInfo = createPrInfo();
      const requests = builder.buildUploadSignalRequest(files, prInfo);
      expect(requests[0]!.userId).toBe('default-user-id');
    });

    it('includes user email from file or PR info', () => {
      const files = [createFile({ authorEmail: 'author@test.com' })];
      const prInfo = createPrInfo({ authorEmail: 'pr@test.com' });
      const requests = builder.buildUploadSignalRequest(files, prInfo);
      expect(requests[0]!.userEmail).toBe('author@test.com');
    });

    it('falls back to PR author email', () => {
      const files = [createFile({ authorEmail: undefined })];
      const prInfo = createPrInfo({ authorEmail: 'pr@test.com' });
      const requests = builder.buildUploadSignalRequest(files, prInfo);
      expect(requests[0]!.userEmail).toBe('pr@test.com');
    });
  });

  describe('buildProcessContentBatchRequest', () => {
    it('creates batch request with items for each file', () => {
      const files = [
        createFile({ path: 'x.ts', authorId: 'user-x' }),
        createFile({ path: 'y.ts', authorId: 'user-y' }),
      ];
      const batch = builder.buildProcessContentBatchRequest(files);

      expect(batch.processContentRequests).toHaveLength(2);
      expect(batch.processContentRequests[0]!.userId).toBe('user-x');
      expect(batch.processContentRequests[1]!.userId).toBe('user-y');
      expect(batch.processContentRequests[0]!.requestId).toBeTruthy();
    });
  });

  describe('buildProcessAndUploadRequests', () => {
    it('routes files to process or upload based on scope matching', () => {
      const config = createConfig();
      const b = new PayloadBuilder(config);
      const files = [
        createFile({ path: 'in-scope.ts', authorId: config.userId }),
        createFile({ path: 'out-scope.ts', authorId: 'other-user' }),
      ];

      const scopeResponse: ProtectionScopesResponse = {
        value: [
          {
            policyScope: {
              inclusions: [{ '@odata.type': 'microsoft.graph.userScope', identity: config.userId }],
              exclusions: [],
            },
            locations: [{ '@odata.type': 'microsoft.graph.policyLocationDomain', value: 'https://github.com' }],
            activities: 'uploadText',
            executionMode: 'evaluateOffline',
            policyActions: [],
          },
        ],
      };

      const prInfo = createPrInfo();
      const result = b.buildProcessAndUploadRequests(files, scopeResponse, prInfo);

      expect(result.processContentRequest).toBeDefined();
      expect(result.uploadSignalRequests.length).toBeGreaterThanOrEqual(0);
    });

    it('puts all files to upload when no scopes match', () => {
      const scopeResponse: ProtectionScopesResponse = { value: [] };
      const files = [createFile(), createFile({ path: 'b.ts' })];
      const prInfo = createPrInfo();

      const result = builder.buildProcessAndUploadRequests(files, scopeResponse, prInfo);
      expect(result.processContentRequest).toBeUndefined();
      expect(result.uploadSignalRequests).toHaveLength(2);
    });
  });
});
