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
jest.mock('../../src/api/purviewClient', () => ({ PurviewClient: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../src/auth/authenticationService', () => ({ AuthenticationService: jest.fn().mockImplementation(() => ({})) }));

jest.mock('child_process', () => ({
  execFileSync: jest.fn(() => 'author@contoso.com\n'),
}));

import { execFileSync } from 'child_process';
import { FileProcessor } from '../../src/file/fileProcessor';
import { ActionConfig, FileMetadata } from '../../src/config/types';

const mockExecFileSync = execFileSync as unknown as jest.Mock;

function createConfig(): ActionConfig {
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
  };
}

describe('FileProcessor — git invocation is shell-free', () => {
  let processor: FileProcessor;

  beforeEach(() => {
    mockExecFileSync.mockClear();
    processor = new FileProcessor(createConfig());
  });

  it('passes a hostile file path as a single argv element, not shell text', () => {
    const hostile = 'evil".txt; touch /tmp/pwned; echo "';
    const files = [{ path: hostile, size: 1, encoding: 'utf-8', typeOfChange: 'unknown' }] as unknown as FileMetadata[];

    const map = (processor as any).getFileAuthorEmails(files);

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['log', '-1', '--format=%ae', '--', hostile],
      expect.objectContaining({ encoding: 'utf-8' })
    );
    expect(map[hostile]).toBe('author@contoso.com');
  });
});
