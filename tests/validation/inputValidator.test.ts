jest.mock('@actions/core', () => ({
  getBooleanInput: jest.fn().mockReturnValue(false),
  getInput: jest.fn(),
  getIDToken: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  setFailed: jest.fn(),
}));

jest.mock('@actions/github', () => ({
  context: {
    repo: { owner: 'test-owner', repo: 'test-repo' },
    ref: 'refs/heads/main',
    sha: 'abc123',
    runId: 12345,
    runNumber: 1,
  },
  getOctokit: jest.fn(),
}));

import * as core from '@actions/core';
import { validateInputs } from '../../src/validation/inputValidator';
import * as fs from 'fs';
import * as path from 'path';

describe('inputValidator', () => {
  const validGuid = '12345678-1234-1234-1234-123456789abc';
  const validTenantId = 'abcdef01-2345-6789-abcd-ef0123456789';
  const tmpDir = path.join(__dirname, '..', '.tmp-validation');
  const usersJsonPath = path.join(tmpDir, 'users.json');

  const validUsersJson = {
    users: [{ email: 'test@test.com', userId: 'user-id-1' }],
    defaultUserId: 'default-user-123',
  };

  function setupInputMocks(overrides: Record<string, string> = {}) {
    const defaults: Record<string, string> = {
      'client-id': validGuid,
      'client-certificate': '',
      'tenant-id': validTenantId,
      'purview-account-name': 'test-account',
      'purview-endpoint': 'https://graph.microsoft.com/v1.0',
      'users-json-path': usersJsonPath,
      'file-patterns': '**',
      'exclude-patterns': '',
      'max-file-size': '10485760',
      'debug': 'false',
      'state-repo-branch': '',
      'state-repo-token': '',
      ...overrides,
    };

    (core.getInput as jest.Mock).mockImplementation((name: string) => defaults[name] ?? '');
    (core.getBooleanInput as jest.Mock).mockImplementation((name: string) => {
      if (name === 'debug') return defaults['debug'] === 'true';
      return false;
    });
  }

  beforeAll(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env['GITHUB_WORKFLOW_REF'];
    delete process.env['GITHUB_WORKSPACE'];
    delete process.env['AZURE_CLIENT_SECRET'];
    fs.writeFileSync(usersJsonPath, JSON.stringify(validUsersJson), 'utf-8');
    setupInputMocks();
  });

  afterAll(() => {
    if (fs.existsSync(usersJsonPath)) fs.unlinkSync(usersJsonPath);
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns valid config with correct inputs', async () => {
    const config = await validateInputs();
    expect(config.clientId).toBe(validGuid);
    expect(config.tenantId).toBe(validTenantId);
    expect(config.purviewEndpoint).toBe('https://graph.microsoft.com/v1.0');
    expect(config.userId).toBe('default-user-123');
    expect(config.userMappings).toHaveLength(1);
    expect(config.repository.owner).toBe('test-owner');
    expect(config.repository.repo).toBe('test-repo');
    expect(config.maxFileSize).toBe(10485760);
  });

  it('always includes **/.git/** in excludePatterns even with custom patterns', async () => {
    setupInputMocks({ 'exclude-patterns': '**/.git/**,dist/**' });
    const config = await validateInputs();
    expect(config.excludePatterns).toContain('**/.git/**');
    expect(config.excludePatterns).toContain('dist/**');
    // Should be deduplicated
    const gitPatternCount = config.excludePatterns!.filter(p => p === '**/.git/**').length;
    expect(gitPatternCount).toBe(1);
  });

  it('throws on invalid client-id GUID', async () => {
    setupInputMocks({ 'client-id': 'not-a-guid' });
    await expect(validateInputs()).rejects.toThrow(/Invalid client-id/);
  });

  it('throws on invalid tenant-id GUID', async () => {
    setupInputMocks({ 'tenant-id': 'bad-tenant' });
    await expect(validateInputs()).rejects.toThrow(/Invalid tenant-id/);
  });

  it('defaults purview-endpoint when invalid URL is provided', async () => {
    setupInputMocks({ 'purview-endpoint': 'not-a-url' });
    const config = await validateInputs();
    expect(config.purviewEndpoint).toBe('https://graph.microsoft.com/v1.0');
  });

  it('throws on invalid max-file-size', async () => {
    setupInputMocks({ 'max-file-size': '-1' });
    await expect(validateInputs()).rejects.toThrow(/Invalid max-file-size/);
  });

  it('throws on NaN max-file-size', async () => {
    setupInputMocks({ 'max-file-size': 'abc' });
    await expect(validateInputs()).rejects.toThrow(/Invalid max-file-size/);
  });

  it('throws when users.json is missing', async () => {
    setupInputMocks({ 'users-json-path': '/nonexistent/users.json' });
    await expect(validateInputs()).rejects.toThrow(/users\.json not found/);
  });

  it('throws when users.json lacks defaultUserId', async () => {
    fs.writeFileSync(usersJsonPath, JSON.stringify({ users: [], defaultUserId: '' }), 'utf-8');
    await expect(validateInputs()).rejects.toThrow(/defaultUserId/);
  });

  it('throws when users.json lacks users array', async () => {
    fs.writeFileSync(usersJsonPath, JSON.stringify({ defaultUserId: 'abc' }), 'utf-8');
    await expect(validateInputs()).rejects.toThrow(/users.*array/);
  });

  it('parses file-patterns correctly', async () => {
    setupInputMocks({ 'file-patterns': '*.ts, *.js, *.py' });
    const config = await validateInputs();
    expect(config.filePatterns).toEqual(['*.ts', '*.js', '*.py']);
  });

  it('validates PEM certificate format', async () => {
    setupInputMocks({ 'client-certificate': 'not a pem' });
    await expect(validateInputs()).rejects.toThrow(/Invalid client-certificate/);
  });

  it('accepts valid PEM certificate', async () => {
    const validPem = [
      '-----BEGIN CERTIFICATE-----',
      'MIIBkTCB+wIJALR...',
      '-----END CERTIFICATE-----',
      '-----BEGIN PRIVATE KEY-----',
      'MIIBvAIBADANBgk...',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    setupInputMocks({ 'client-certificate': validPem });
    const config = await validateInputs();
    expect(config.clientCertificatePem).toBe(validPem);
  });

  it('throws when state-repo-branch is set without state-repo-token', async () => {
    setupInputMocks({
      'state-repo-branch': 'main',
      'state-repo-token': '',
    });
    await expect(validateInputs()).rejects.toThrow(/state-repo-branch.*state-repo-token/);
  });

  it('reads AZURE_CLIENT_SECRET from environment variable', async () => {
    process.env['AZURE_CLIENT_SECRET'] = 'my-super-secret';
    const config = await validateInputs();
    expect(config.clientSecret).toBe('my-super-secret');
  });

  it('sets clientSecret to undefined when AZURE_CLIENT_SECRET is not set', async () => {
    const config = await validateInputs();
    expect(config.clientSecret).toBeUndefined();
  });

  it('keeps both clientCertificatePem and clientSecret when both are provided', async () => {
    const validPem = [
      '-----BEGIN CERTIFICATE-----',
      'MIIBkTCB+wIJALR...',
      '-----END CERTIFICATE-----',
      '-----BEGIN PRIVATE KEY-----',
      'MIIBvAIBADANBgk...',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    setupInputMocks({ 'client-certificate': validPem });
    process.env['AZURE_CLIENT_SECRET'] = 'my-secret';
    const config = await validateInputs();
    expect(config.clientCertificatePem).toBe(validPem);
    expect(config.clientSecret).toBe('my-secret');
  });

  describe('cross-repo users.json fetch', () => {
    const github = require('@actions/github');

    beforeEach(() => {
      process.env['GITHUB_WORKFLOW_REF'] =
        'external-owner/ExternalWorkflow/.github/workflows/ci.yml@refs/heads/main';
    });

    function setupCrossRepoMocks(overrides: Record<string, string> = {}) {
      setupInputMocks({
        'state-repo-token': 'ghp_faketoken',
        'users-json-path': 'users.json',
        ...overrides,
      });
    }

    it('throws helpful message on 404 mentioning token and ref', async () => {
      const err: any = new Error('Not Found');
      err.status = 404;
      const mockGetContent = jest.fn().mockRejectedValue(err);
      github.getOctokit.mockReturnValue({ rest: { repos: { getContent: mockGetContent } } });
      setupCrossRepoMocks();

      await expect(validateInputs()).rejects.toThrow(/token lacks read access.*private repo/);
    });

    it('throws auth error on 403', async () => {
      const err: any = new Error('Forbidden');
      err.status = 403;
      const mockGetContent = jest.fn().mockRejectedValue(err);
      github.getOctokit.mockReturnValue({ rest: { repos: { getContent: mockGetContent } } });
      setupCrossRepoMocks();

      await expect(validateInputs()).rejects.toThrow(/Authentication failed.*403/);
    });

    it('throws auth error on 401', async () => {
      const err: any = new Error('Unauthorized');
      err.status = 401;
      const mockGetContent = jest.fn().mockRejectedValue(err);
      github.getOctokit.mockReturnValue({ rest: { repos: { getContent: mockGetContent } } });
      setupCrossRepoMocks();

      await expect(validateInputs()).rejects.toThrow(/Authentication failed.*401/);
    });

    it('succeeds when API returns valid content', async () => {
      const encoded = Buffer.from(JSON.stringify(validUsersJson)).toString('base64');
      const mockGetContent = jest.fn().mockResolvedValue({
        data: { content: encoded, type: 'file' },
      });
      github.getOctokit.mockReturnValue({ rest: { repos: { getContent: mockGetContent } } });
      setupCrossRepoMocks();

      const config = await validateInputs();
      expect(config.userId).toBe('default-user-123');
      expect(mockGetContent).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'external-owner',
          repo: 'ExternalWorkflow',
          path: 'users.json',
          ref: 'refs/heads/main',
        })
      );
    });
  });
});
