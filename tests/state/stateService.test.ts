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
  getOctokit: jest.fn(),
}));

import * as github from '@actions/github';
import { StateService } from '../../src/state/stateService';

describe('StateService', () => {
  describe('defaultStatePathForTarget', () => {
    it('builds path from owner and repo', () => {
      const result = StateService.defaultStatePathForTarget('MyOrg', 'MyRepo');
      expect(result).toBe('.purview/state/MyOrg-MyRepo.json');
    });

    it('sanitizes special characters in owner', () => {
      const result = StateService.defaultStatePathForTarget('my/org@special', 'repo');
      expect(result).toBe('.purview/state/my_org_special-repo.json');
    });

    it('sanitizes special characters in repo', () => {
      const result = StateService.defaultStatePathForTarget('owner', 'my repo!');
      expect(result).toBe('.purview/state/owner-my_repo_.json');
    });

    it('preserves dots, hyphens, and underscores', () => {
      const result = StateService.defaultStatePathForTarget('my-org_1', 'my.repo-2');
      expect(result).toBe('.purview/state/my-org_1-my.repo-2.json');
    });
  });

  describe('lookupStateFile', () => {
    it('returns exists=true with sha when file exists', async () => {
      const mockGetContent = jest.fn().mockResolvedValue({
        data: { sha: 'file-sha-123', type: 'file' },
      });
      (github.getOctokit as jest.Mock).mockReturnValue({
        rest: { repos: { getContent: mockGetContent } },
      });

      const service = new StateService();
      const result = await service.lookupStateFile(
        { owner: 'org', repo: 'repo', branch: 'main', token: 'tok' },
        '.purview/state/org-repo.json'
      );

      expect(result.exists).toBe(true);
      expect(result.sha).toBe('file-sha-123');
      expect(mockGetContent).toHaveBeenCalledWith({
        owner: 'org',
        repo: 'repo',
        path: '.purview/state/org-repo.json',
        ref: 'main',
      });
    });

    it('returns exists=false when file not found (404)', async () => {
      const mockGetContent = jest.fn().mockRejectedValue({ status: 404 });
      (github.getOctokit as jest.Mock).mockReturnValue({
        rest: { repos: { getContent: mockGetContent } },
      });

      const service = new StateService();
      const result = await service.lookupStateFile(
        { owner: 'org', repo: 'repo', branch: 'main', token: 'tok' },
        '.purview/state/missing.json'
      );

      expect(result.exists).toBe(false);
      expect(result.sha).toBeUndefined();
    });

    it('throws on non-404 errors', async () => {
      const mockGetContent = jest.fn().mockRejectedValue({ status: 500, message: 'Server Error' });
      (github.getOctokit as jest.Mock).mockReturnValue({
        rest: { repos: { getContent: mockGetContent } },
      });

      const service = new StateService();
      await expect(
        service.lookupStateFile(
          { owner: 'org', repo: 'repo', branch: 'main', token: 'tok' },
          '.purview/state/error.json'
        )
      ).rejects.toEqual({ status: 500, message: 'Server Error' });
    });

    it('returns exists=true without sha when data is array (directory)', async () => {
      const mockGetContent = jest.fn().mockResolvedValue({
        data: [{ name: 'file.json' }],
      });
      (github.getOctokit as jest.Mock).mockReturnValue({
        rest: { repos: { getContent: mockGetContent } },
      });

      const service = new StateService();
      const result = await service.lookupStateFile(
        { owner: 'org', repo: 'repo', branch: 'main', token: 'tok' },
        '.purview/state/'
      );

      expect(result.exists).toBe(true);
      expect(result.sha).toBeUndefined();
    });
  });

  describe('writeStateFile', () => {
    it('creates or updates file with base64 content', async () => {
      const mockGetContent = jest.fn().mockResolvedValue({
        data: { sha: 'existing-sha' },
      });
      const mockCreateOrUpdate = jest.fn().mockResolvedValue({});
      (github.getOctokit as jest.Mock).mockReturnValue({
        rest: {
          repos: {
            getContent: mockGetContent,
            createOrUpdateFileContents: mockCreateOrUpdate,
          },
        },
      });

      const service = new StateService();
      const stateRepo = { owner: 'org', repo: 'repo', branch: 'main', token: 'tok' };
      const state = { firstRun: true, timestamp: '2024-01-01' };

      await service.writeStateFile(stateRepo, '.purview/state/test.json', state, 'chore: init state');

      expect(mockCreateOrUpdate).toHaveBeenCalledTimes(1);
      const call = mockCreateOrUpdate.mock.calls[0][0];
      expect(call.owner).toBe('org');
      expect(call.repo).toBe('repo');
      expect(call.path).toBe('.purview/state/test.json');
      expect(call.message).toBe('chore: init state');
      expect(call.branch).toBe('main');
      expect(call.sha).toBe('existing-sha');

      // Verify content is base64 encoded
      const decoded = Buffer.from(call.content, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);
      expect(parsed.firstRun).toBe(true);
    });

    it('creates new file when lookup returns exists=false', async () => {
      const mockGetContent = jest.fn().mockRejectedValue({ status: 404 });
      const mockCreateOrUpdate = jest.fn().mockResolvedValue({});
      (github.getOctokit as jest.Mock).mockReturnValue({
        rest: {
          repos: {
            getContent: mockGetContent,
            createOrUpdateFileContents: mockCreateOrUpdate,
          },
        },
      });

      const service = new StateService();
      await service.writeStateFile(
        { owner: 'org', repo: 'repo', branch: 'main', token: 'tok' },
        '.purview/state/new.json',
        { new: true },
        'init'
      );

      const call = mockCreateOrUpdate.mock.calls[0][0];
      expect(call.sha).toBeUndefined();
    });
  });
});
