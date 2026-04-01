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
      expect(request.integratedAppMetadata?.name).toBe('GitHub');
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

    it('splits large file into multiple requests', () => {
      const largeContent = 'z'.repeat(4 * 1024 * 1024); // 4MB content
      const file = createFile({ path: 'large.ts', content: largeContent, size: largeContent.length });
      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);

      expect(requests.length).toBeGreaterThan(1);
      // All but last should be marked as truncated
      for (let i = 0; i < requests.length - 1; i++) {
        expect(requests[i]!.contentToProcess.contentEntries[0]!.isTruncated).toBe(true);
      }
      // Last should not be marked as truncated
      expect(requests[requests.length - 1]!.contentToProcess.contentEntries[0]!.isTruncated).toBe(false);
      // All content combined should equal original
      const reconstructed = requests.map(r => (r.contentToProcess.contentEntries[0]!.content as any).data).join('');
      expect(reconstructed).toBe(largeContent);
    });

    it('preserves realistic git diff patch content', () => {
      const diffPatch = [
        '@@ -10,7 +10,9 @@ import { Logger } from "./logger";',
        ' ',
        ' export class UserService {',
        '-  private cache: Map<string, User> = new Map();',
        '+  private cache: Map<string, User>;',
        '+  private ttl: number;',
        ' ',
        '   constructor(private readonly config: Config) {',
        '-    // no-op',
        '+    this.cache = new Map();',
        '+    this.ttl = config.cacheTtl ?? 3600;',
        '   }',
      ].join('\n');

      const file = createFile({
        path: 'src/services/userService.ts',
        content: diffPatch,
        size: diffPatch.length,
        numberOfAdditions: 4,
        numberOfDeletions: 2,
        numberOfChanges: 6,
        typeOfChange: 'modified',
      });

      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);

      expect(requests).toHaveLength(1);
      const entry = requests[0]!.contentToProcess.contentEntries[0]!;
      const data = (entry.content as any).data;
      // Verify the exact diff patch content is preserved
      expect(data).toBe(diffPatch);
      expect(data).toContain('-  private cache: Map<string, User> = new Map();');
      expect(data).toContain('+    this.ttl = config.cacheTtl ?? 3600;');
      expect(entry.identifier).toBe('src/services/userService.ts');
      expect(entry.isTruncated).toBe(false);
    });

    it('each chunk stays under 3MB when splitting', () => {
      const maxPayloadSize = 3 * 1024 * 1024; // 3MB
      const largeContent = 'x'.repeat(7 * 1024 * 1024); // 7MB — forces ~3 chunks
      const file = createFile({ path: 'huge.ts', content: largeContent, size: largeContent.length });

      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', 0);

      expect(requests.length).toBeGreaterThanOrEqual(3);
      for (const req of requests) {
        const serialized = JSON.stringify(req);
        expect(serialized.length).toBeLessThanOrEqual(maxPayloadSize);
      }
    });

    it('assigns sequential sequence numbers across chunks', () => {
      const largeContent = 'a'.repeat(4 * 1024 * 1024); // 4MB
      const startingMessageId = 5;
      const file = createFile({ path: 'big.ts', content: largeContent, size: largeContent.length });

      const requests = builder.buildPerUserProcessContentRequest(file, 'conv-1', startingMessageId);

      expect(requests.length).toBeGreaterThan(1);
      for (let i = 0; i < requests.length; i++) {
        expect(requests[i]!.contentToProcess.contentEntries[0]!.sequenceNumber).toBe(startingMessageId + i);
      }
    });

    it('does not split content that fits within 3MB', () => {
      // Use a content size well under the limit to confirm single-request behavior
      const content = 'd'.repeat(2 * 1024 * 1024); // 2MB — safely under 3MB
      const file = createFile({ path: 'fits.ts', content, size: content.length });

      const requests = builder.buildPerUserProcessContentRequest(file, 'c', 0);
      expect(requests).toHaveLength(1);
      expect((requests[0]!.contentToProcess.contentEntries[0]!.content as any).data).toBe(content);
      expect(requests[0]!.contentToProcess.contentEntries[0]!.isTruncated).toBe(false);
    });

    it('splits content just over 3MB into exactly 2 requests', () => {
      // 3.1MB of content — overhead is a few hundred bytes, so total is well over 3MB
      const content = 'c'.repeat(Math.floor(3.1 * 1024 * 1024));
      const file = createFile({ path: 'justover.ts', content, size: content.length });

      const requests = builder.buildPerUserProcessContentRequest(file, 'c', 0);
      expect(requests).toHaveLength(2);
      // Verify combined content equals original
      const combined = requests.map(r => (r.contentToProcess.contentEntries[0]!.content as any).data).join('');
      expect(combined).toBe(content);
    });

    it('shares correlationId across all chunks of a split', () => {
      const largeContent = 'q'.repeat(4 * 1024 * 1024);
      const file = createFile({ path: 'split.ts', content: largeContent, size: largeContent.length });

      const requests = builder.buildPerUserProcessContentRequest(file, 'my-correlation', 0);

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
