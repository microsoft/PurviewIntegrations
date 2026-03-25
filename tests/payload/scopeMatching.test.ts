jest.mock('@actions/core', () => ({
  getBooleanInput: jest.fn().mockReturnValue(false),
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import { PayloadBuilder } from '../../src/payload/payloadBuilder';
import {
  ActionConfig,
  FileMetadata,
  PolicyScopes,
  PolicyLocation,
  ProtectionScopesResponse,
  PrInfo,
  Activity,
  ExecutionMode,
} from '../../src/config/types';

function makeConfig(overrides: Partial<ActionConfig> = {}): ActionConfig {
  return {
    clientId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    tenantId: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
    purviewAccountName: 'acct',
    purviewEndpoint: 'https://graph.microsoft.com/v1.0',
    filePatterns: ['**'],
    maxFileSize: 10485760,
    debug: false,
    userId: 'default-user-id',
    repository: { owner: 'org', repo: 'repo', branch: 'main', sha: 'abc', runId: '1', runNumber: '1' },
    ...overrides,
  };
}

function makeScope(overrides: Partial<PolicyScopes> = {}): PolicyScopes {
  return {
    policyScope: { inclusions: [{ "@odata.type": "microsoft.graph.allScope", identity: "All" }], exclusions: [] },
    locations: [{ "@odata.type": "microsoft.graph.policyLocationDomain", value: "https://github.com" }],
    activities: "uploadText",
    executionMode: "evaluateOffline",
    policyActions: [],
    ...overrides,
  };
}

const domainLocation: PolicyLocation = {
  "@odata.type": "microsoft.graph.policyLocationDomain",
  value: "https://github.com",
};

const prInfo: PrInfo = {
  iterations: 1, authorLogin: 'user', authorEmail: 'user@test.com',
  head: 'abc', base: 'def', title: 'PR', url: null,
};

describe('PayloadBuilder — scope matching', () => {
  let builder: PayloadBuilder;
  beforeEach(() => { builder = new PayloadBuilder(makeConfig()); });

  describe('checkApplicableScopes', () => {
    it('returns shouldProcess=false when no scopes match', () => {
      const result = builder.checkApplicableScopes([], Activity.uploadText, domainLocation);
      expect(result.shouldProcess).toBe(false);
    });

    it('matches on activity + domain location', () => {
      const result = builder.checkApplicableScopes([makeScope()], Activity.uploadText, domainLocation);
      expect(result.shouldProcess).toBe(true);
    });

    it('does not match when activity differs', () => {
      const scope = makeScope({ activities: "downloadText" });
      const result = builder.checkApplicableScopes([scope], Activity.uploadText, domainLocation);
      expect(result.shouldProcess).toBe(false);
    });

    it('does not match when location differs', () => {
      const scope = makeScope({
        locations: [{ "@odata.type": "microsoft.graph.policyLocationDomain", value: "https://other.com" }],
      });
      const result = builder.checkApplicableScopes([scope], Activity.uploadText, domainLocation);
      expect(result.shouldProcess).toBe(false);
    });

    it('matches policyLocationApplication by clientId', () => {
      const scope = makeScope({
        locations: [{ "@odata.type": "microsoft.graph.policyLocationApplication", value: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }],
      });
      const result = builder.checkApplicableScopes([scope], Activity.uploadText, domainLocation);
      expect(result.shouldProcess).toBe(true);
    });

    it('upgrades to evaluateInline when any scope is inline (sticky)', () => {
      const offlineScope = makeScope({ executionMode: "evaluateOffline" });
      const inlineScope = makeScope({ executionMode: "evaluateInline" });
      const result = builder.checkApplicableScopes([offlineScope, inlineScope], Activity.uploadText, domainLocation);
      expect(result.executionMode).toBe(ExecutionMode.evaluateInline);
    });

    it('accumulates policyActions from all matching scopes', () => {
      const s1 = makeScope({ policyActions: [{ action: 'blockAccess', policyName: 'P1' }] });
      const s2 = makeScope({ policyActions: [{ action: 'notify', policyName: 'P2' }] });
      const result = builder.checkApplicableScopes([s1, s2], Activity.uploadText, domainLocation);
      expect(result.dlpActions).toHaveLength(2);
    });
  });

  describe('buildProcessAndUploadRequests — inclusion/exclusion', () => {
    const file: FileMetadata = {
      path: 'src/index.ts', size: 100, encoding: 'utf-8', sha: 'abc',
      content: 'console.log("hi")', authorId: 'default-user-id',
    };

    it('routes file to process when included and location matches', () => {
      const scopeResponse: ProtectionScopesResponse = { value: [makeScope()] };
      const result = builder.buildProcessAndUploadRequests([file], scopeResponse, prInfo);
      const allItems = result.processContentRequests.flatMap(b => b.processContentRequests);
      expect(allItems).toHaveLength(1);
      expect(result.uploadSignalRequests).toHaveLength(0);
    });

    it('routes file to upload when no scopes match', () => {
      const scopeResponse: ProtectionScopesResponse = { value: [] };
      const result = builder.buildProcessAndUploadRequests([file], scopeResponse, prInfo);
      expect(result.processContentRequests).toHaveLength(0);
      expect(result.uploadSignalRequests).toHaveLength(1);
    });

    it('routes file to upload when activity does not match', () => {
      const scope = makeScope({ activities: "downloadFile" });
      const result = builder.buildProcessAndUploadRequests([file], { value: [scope] }, prInfo);
      expect(result.processContentRequests).toHaveLength(0);
      expect(result.uploadSignalRequests).toHaveLength(1);
    });

    it('matches inclusion by tenantScope', () => {
      const scope = makeScope({
        policyScope: {
          inclusions: [{ "@odata.type": "microsoft.graph.tenantScope", identity: 'tttttttt-tttt-tttt-tttt-tttttttttttt' }],
          exclusions: [],
        },
      });
      const result = builder.buildProcessAndUploadRequests([file], { value: [scope] }, prInfo);
      const allItems = result.processContentRequests.flatMap(b => b.processContentRequests);
      expect(allItems).toHaveLength(1);
    });

    it('matches inclusion by userScope', () => {
      const scope = makeScope({
        policyScope: {
          inclusions: [{ "@odata.type": "microsoft.graph.userScope", identity: 'default-user-id' }],
          exclusions: [],
        },
      });
      const result = builder.buildProcessAndUploadRequests([file], { value: [scope] }, prInfo);
      const allItems = result.processContentRequests.flatMap(b => b.processContentRequests);
      expect(allItems).toHaveLength(1);
    });

    it('routes to upload when location is "all"', () => {
      // "all" location match in buildProcessAndUploadRequests triggers locationMatch=true
      const scope = makeScope({
        locations: [{ "@odata.type": "microsoft.graph.policyLocationDomain", value: "all" }],
      });
      const result = builder.buildProcessAndUploadRequests([file], { value: [scope] }, prInfo);
      const allItems = result.processContentRequests.flatMap(b => b.processContentRequests);
      expect(allItems).toHaveLength(1);
    });

    it('exclusion with "all" identity excludes the file', () => {
      const scope = makeScope({
        policyScope: {
          inclusions: [{ "@odata.type": "microsoft.graph.allScope", identity: "All" }],
          exclusions: [{ "@odata.type": "microsoft.graph.allScope", identity: "All" }],
        },
      });
      const result = builder.buildProcessAndUploadRequests([file], { value: [scope] }, prInfo);
      // With exclusion identity="All", isExcluded should be true, so file goes to upload
      expect(result.processContentRequests).toHaveLength(0);
      expect(result.uploadSignalRequests).toHaveLength(1);
    });
  });
});
