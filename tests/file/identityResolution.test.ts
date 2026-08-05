jest.mock('@actions/core', () => ({
  getBooleanInput: jest.fn().mockReturnValue(false),
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
}));

jest.mock('@actions/github', () => ({
  getOctokit: jest.fn(() => ({})),
  context: {
    eventName: 'pull_request',
    payload: {},
    repo: { owner: 'test', repo: 'test' },
    ref: 'refs/heads/main',
    sha: 'abc123',
  },
}));

jest.mock('@actions/glob', () => ({ create: jest.fn() }));
jest.mock('is-binary-path', () => ({ default: jest.fn(() => false) }));

const mockGetUserInfo = jest.fn();
jest.mock('../../src/api/purviewClient', () => ({
  PurviewClient: jest.fn().mockImplementation(() => ({
    setAuthToken: jest.fn(),
    getUserInfo: mockGetUserInfo,
  })),
}));
jest.mock('../../src/auth/authenticationService', () => ({
  AuthenticationService: jest.fn().mockImplementation(() => ({
    getToken: jest.fn().mockResolvedValue({ accessToken: 'token' }),
  })),
}));

import { FileProcessor } from '../../src/file/fileProcessor';
import { ActionConfig } from '../../src/config/types';

const DEFAULT_USER = 'dddddddd-0000-4000-8000-dddddddddddd';
const ALICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function createConfig(overrides: Partial<ActionConfig> = {}): ActionConfig {
  return {
    clientId: '11111111-1111-1111-1111-111111111111',
    tenantId: '22222222-2222-2222-2222-222222222222',
    purviewAccountName: 'test-account',
    purviewEndpoint: 'https://graph.microsoft.com/v1.0',
    filePatterns: ['**'],
    maxFileSize: 10485760,
    debug: false,
    userId: DEFAULT_USER,
    repository: {
      owner: 'testOwner',
      repo: 'testRepo',
      branch: 'main',
      sha: 'abc123',
      runId: '999',
      runNumber: '1',
    },
    ...overrides,
  } as ActionConfig;
}

const resolve = (processor: FileProcessor, emails: string[]) =>
  (processor as any).resolveUserIds(new Set(emails)) as Promise<Record<string, string>>;

describe('FileProcessor.resolveUserIds', () => {
  beforeEach(() => {
    mockGetUserInfo.mockReset();
  });

  it('resolves known authors and falls back to the default identity for the rest', async () => {
    mockGetUserInfo.mockResolvedValue({
      success: true,
      data: { value: [{ id: ALICE, userPrincipalName: 'Alice@contoso.com' }] },
    });
    const processor = new FileProcessor(createConfig());

    const map = await resolve(processor, ['alice@contoso.com', 'nobody@contoso.com']);

    expect(map['alice@contoso.com']).toBe(ALICE);
    expect(map['nobody@contoso.com']).toBe(DEFAULT_USER);
  });

  it('never sends a malformed author email to Graph, but still assigns the default identity', async () => {
    mockGetUserInfo.mockResolvedValue({ success: true, data: { value: [] } });
    const processor = new FileProcessor(createConfig());
    const hostile = `x@y.com' or true or '`;

    const map = await resolve(processor, ['not-an-email', hostile, 'alice@contoso.com']);

    expect(mockGetUserInfo).toHaveBeenCalledWith(['alice@contoso.com']);
    expect(map['not-an-email']).toBe(DEFAULT_USER);
    expect(map[hostile]).toBe(DEFAULT_USER);
  });

  it('uses users.json mappings', async () => {
    mockGetUserInfo.mockResolvedValue({ success: true, data: { value: [] } });
    const processor = new FileProcessor(
      createConfig({ userMappings: [{ email: 'alice@contoso.com', userId: ALICE }] })
    );

    const map = await resolve(processor, ['alice@contoso.com', 'mallory@contoso.com']);

    expect(map['alice@contoso.com']).toBe(ALICE);
    expect(map['mallory@contoso.com']).toBe(DEFAULT_USER);
  });

  it('caches a not-found so Graph is queried only once', async () => {
    mockGetUserInfo.mockResolvedValue({ success: true, data: { value: [] } });
    const processor = new FileProcessor(createConfig());

    await resolve(processor, ['ghost@contoso.com']);
    const second = await resolve(processor, ['ghost@contoso.com']);

    expect(second['ghost@contoso.com']).toBe(DEFAULT_USER);
    expect(mockGetUserInfo).toHaveBeenCalledTimes(1);
  });
});
