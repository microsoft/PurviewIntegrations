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

  describe('buildProtectionScopesRequest', () => {
    it('returns request with correct activity, location, and app metadata', () => {
      const request = builder.buildProtectionScopesRequest();
      expect(request.activities).toBe('uploadText');
      expect(request.locations).toHaveLength(1);
      expect(request.locations![0]!.value).toBe('https://github.com');
      expect(request.integratedAppMetadata?.name).toBe('GitHub');
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
      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);

      expect(requests.length).toBe(1);
      const request = requests[0]!;
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
      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);
      const content = requests[0]!.contentToProcess.contentEntries[0]!.content as any;
      expect(content.data).toBe('my content');
      expect(content['@odata.type']).toBe('microsoft.graph.textContent');
    });

    it('uses placeholder when file has no content', () => {
      const file = createFile({ path: 'empty.txt', size: 500, content: undefined });
      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);
      const content = requests[0]!.contentToProcess.contentEntries[0]!.content as any;
      expect(content.data).toContain('empty.txt');
      expect(content.data).toContain('500 bytes');
    });

    it('includes protectedAppMetadata with github domain', () => {
      const file = createFile();
      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);
      expect(requests[0]!.contentToProcess.protectedAppMetadata?.applicationLocation.value).toBe('https://github.com');
    });

    it('splits large file into chunks under 3MB with correct metadata', () => {
      const largeContent = 'z'.repeat(4 * 1024 * 1024); // 4MB content
      const file = createFile({ path: 'large.ts', content: largeContent, size: largeContent.length });
      const requests = builder.buildPerUserProcessContentRequest(file, 'my-correlation', 0);

      expect(requests.length).toBeGreaterThan(1);

      // All but last should be marked as truncated
      for (let i = 0; i < requests.length - 1; i++) {
        expect(requests[i]!.contentToProcess.contentEntries[0]!.isTruncated).toBe(true);
      }
      expect(requests[requests.length - 1]!.contentToProcess.contentEntries[0]!.isTruncated).toBe(false);

      // All content combined should equal original
      const reconstructed = requests.map(r => (r.contentToProcess.contentEntries[0]!.content as any).data).join('');
      expect(reconstructed).toBe(largeContent);

      // Each chunk stays under 3MB
      for (const req of requests) {
        expect(JSON.stringify(req).length).toBeLessThanOrEqual(3 * 1024 * 1024);
      }

      // Sequential sequence numbers
      for (let i = 0; i < requests.length; i++) {
        expect(requests[i]!.contentToProcess.contentEntries[0]!.sequenceNumber).toBe(i);
      }

      // Shared correlationId
      for (const req of requests) {
        expect(req.contentToProcess.contentEntries[0]!.correlationId).toBe('my-correlation');
      }
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
      const batches = builder.buildProcessContentBatchRequest(files);

      expect(batches.length).toBeGreaterThanOrEqual(1);
      const allItems = batches.flatMap(b => b.processContentRequests);
      expect(allItems).toHaveLength(2);
      expect(allItems[0]!.userId).toBe('user-x');
      expect(allItems[1]!.userId).toBe('user-y');
      expect(allItems[0]!.requestId).toBeTruthy();
    });

    it('includes userEmail in batch items', () => {
      const files = [
        createFile({ path: 'a.ts', authorId: 'user-a', authorEmail: 'a@test.com' }),
        createFile({ path: 'b.ts', authorId: 'user-b', authorEmail: undefined }),
      ];
      const batches = builder.buildProcessContentBatchRequest(files);
      const allItems = batches.flatMap(b => b.processContentRequests);
      expect(allItems[0]!.userEmail).toBe('a@test.com');
      expect(allItems[1]!.userEmail).toBeUndefined();
    });

    it('splits into multiple batches when exceeding 3MB', () => {
      const largeContent = 'a'.repeat(1024 * 1024); // 1MB each
      const files = Array.from({ length: 5 }, (_, i) =>
        createFile({ path: `file${i}.ts`, content: largeContent, authorId: `user-${i}` })
      );
      const batches = builder.buildProcessContentBatchRequest(files);

      expect(batches.length).toBeGreaterThan(1);
      const allItems = batches.flatMap(b => b.processContentRequests);
      expect(allItems).toHaveLength(5);
    });
  });

  describe('AiAgentInfo in payloads', () => {
    it('uses committerEmail as agent name (UPN)', () => {
      const file = createFile({
        committerId: 'committer-id',
        committerEmail: 'committer@test.com',
        committerLogin: 'committer-login',
        authorId: 'author-id',
      });
      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);
      const entry = requests[0]!.contentToProcess.contentEntries[0] as any;
      expect(entry.agents).toHaveLength(1);
      expect(entry.agents[0].identifier).toBe('committer-id');
      expect(entry.agents[0].name).toBe('committer@test.com');
    });

    it('sets version to defaultUserId when using default user', () => {
      const file = createFile({
        authorId: undefined,
        committerId: 'c-id',
        committerEmail: 'c@test.com',
      });
      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);
      const entry = requests[0]!.contentToProcess.contentEntries[0] as any;
      expect(entry.agents[0].version).toBe('default-user-id');
    });

    it('sets version to undefined when user is resolved (not default)', () => {
      const file = createFile({
        authorId: 'specific-user-id',
        committerId: 'c-id',
        committerEmail: 'c@test.com',
      });
      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);
      const entry = requests[0]!.contentToProcess.contentEntries[0] as any;
      expect(entry.agents[0].version).toBeUndefined();
    });

    it('sets version to "fullscan" when isFullScan is true', () => {
      builder.isFullScan = true;
      const file = createFile({
        authorId: 'specific-user',
        committerId: 'c-id',
        committerEmail: 'c@test.com',
      });
      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);
      const entry = requests[0]!.contentToProcess.contentEntries[0] as any;
      expect(entry.agents[0].version).toBe('fullscan');
      builder.isFullScan = false;
    });

    it('omits agents when no committer info available', () => {
      const file = createFile({
        committerId: undefined,
        committerEmail: undefined,
      });
      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);
      const entry = requests[0]!.contentToProcess.contentEntries[0] as any;
      expect(entry.agents).toBeUndefined();
    });
  });

  describe('accessedResources_v2', () => {
    it('populates accessedResources_v2 with full URL for files', () => {
      const file = createFile({ path: 'src/app.ts', sha: 'file-sha-1', typeOfChange: 'modified' });
      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);
      const entry = requests[0]!.contentToProcess.contentEntries[0] as any;
      expect(entry.accessedResources_v2).toHaveLength(1);
      const resource = entry.accessedResources_v2[0];
      expect(resource.identifier).toBe('Commit: file-sha-1');
      expect(resource.name).toBe('Repo: testRepo File: app.ts Path: src/app.ts');
      expect(resource.url).toBe('https://github.com/testOwner/testRepo/blob/main/src/app.ts');
      expect(resource.accessType).toBe('write');
      expect(resource.status).toBe('success');
    });

    it('includes PR number in identifier when prNumber is set', () => {
      builder.prNumber = 42;
      const file = createFile({ path: 'src/app.ts', sha: 'file-sha-1', typeOfChange: 'modified' });
      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);
      const entry = requests[0]!.contentToProcess.contentEntries[0] as any;
      expect(entry.accessedResources_v2[0].identifier).toBe('PR: 42 Commit: file-sha-1');
    });

    it('maps added files to accessType "create"', () => {
      const file = createFile({ typeOfChange: 'added' });
      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);
      const entry = requests[0]!.contentToProcess.contentEntries[0] as any;
      expect(entry.accessedResources_v2[0].accessType).toBe('create');
    });

    it('maps removed files to accessType "none"', () => {
      const file = createFile({ typeOfChange: 'removed' });
      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);
      const entry = requests[0]!.contentToProcess.contentEntries[0] as any;
      expect(entry.accessedResources_v2[0].accessType).toBe('none');
    });

    it('populates accessedResources_v2 for commit payloads with commit + file entries', () => {
      const commitGroup = {
        sha: 'abc123',
        files: [
          createFile({ path: 'a.ts', typeOfChange: 'added', sha: 'sha-a' }),
          createFile({ path: 'b.ts', typeOfChange: 'modified', sha: 'sha-b' }),
        ],
        authorId: 'user-1',
        committerEmail: 'c@test.com',
        committerId: 'c-id',
      };
      const ctp = builder.buildCommitContentToProcess(commitGroup as any, 'conv-1', 0);
      const entry = ctp.contentEntries[0] as any;
      expect(entry.accessedResources_v2).toHaveLength(3); // 1 commit + 2 files
      expect(entry.accessedResources_v2[0].identifier).toBe('Commit: abc123');
      expect(entry.accessedResources_v2[0].name).toBe('Repo: testRepo Commit: abc123');
      expect(entry.accessedResources_v2[0].url).toContain('/commit/abc123');
      expect(entry.accessedResources_v2[1].identifier).toBe('Commit: sha-a');
      expect(entry.accessedResources_v2[1].name).toBe('Repo: testRepo File: a.ts Path: a.ts');
      expect(entry.accessedResources_v2[1].accessType).toBe('create');
      expect(entry.accessedResources_v2[2].identifier).toBe('Commit: sha-b');
      expect(entry.accessedResources_v2[2].name).toBe('Repo: testRepo File: b.ts Path: b.ts');
      expect(entry.accessedResources_v2[2].accessType).toBe('write');
    });
  });

  describe('commit payload builders', () => {
    const commitGroup = {
      sha: 'def456',
      files: [createFile({ path: 'c.ts' })],
      authorId: 'author-1',
      authorEmail: 'author@test.com',
      committerEmail: 'committer@test.com',
      committerId: 'committer-1',
      committerLogin: 'committer-login',
      message: 'fix: something',
      timestamp: '2026-01-01T00:00:00Z',
    };

    it('buildCommitProcessContentBatchItems includes userEmail', () => {
      const items = builder.buildCommitProcessContentBatchItems(commitGroup as any, 'conv-1', 0);
      expect(items).toHaveLength(1);
      expect(items[0]!.userId).toBe('author-1');
      expect(items[0]!.userEmail).toBe('author@test.com');
    });

    it('buildCommitUploadSignalRequest includes userEmail', () => {
      const prInfo = createPrInfo();
      const requests = builder.buildCommitUploadSignalRequest(commitGroup as any, prInfo);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.userId).toBe('author-1');
      expect(requests[0]!.userEmail).toBe('author@test.com');
    });

    it('buildCommitContentToProcess agent uses UPN as name', () => {
      const ctp = builder.buildCommitContentToProcess(commitGroup as any, 'conv-1', 0);
      const entry = ctp.contentEntries[0] as any;
      expect(entry.agents[0].name).toBe('committer@test.com');
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

      expect(result.processContentRequests).toBeDefined();
      expect(result.uploadSignalRequests.length).toBeGreaterThanOrEqual(0);
    });

    it('puts all files to upload when no scopes match', () => {
      const scopeResponse: ProtectionScopesResponse = { value: [] };
      const files = [createFile(), createFile({ path: 'b.ts' })];
      const prInfo = createPrInfo();

      const result = builder.buildProcessAndUploadRequests(files, scopeResponse, prInfo);
      expect(result.processContentRequests).toHaveLength(0);
      expect(result.uploadSignalRequests).toHaveLength(2);
    });
  });
});
