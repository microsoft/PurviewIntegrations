jest.mock('@actions/core', () => ({
  getBooleanInput: jest.fn().mockReturnValue(false),
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  summary: {
    addHeading: jest.fn().mockReturnThis(),
    addRaw: jest.fn().mockReturnThis(),
    addList: jest.fn().mockReturnThis(),
    addTable: jest.fn().mockReturnThis(),
    write: jest.fn(),
  },
}));

const mockListWorkflowRunsForRepo = jest.fn();
const mockGetWorkflowRun = jest.fn();

jest.mock('@actions/github', () => ({
  getOctokit: jest.fn(() => ({
    rest: {
      actions: {
        listWorkflowRunsForRepo: mockListWorkflowRunsForRepo,
        getWorkflowRun: mockGetWorkflowRun,
      },
    },
  })),
  context: {
    eventName: 'pull_request',
    workflow: '',
    payload: {
      pull_request: {
        head: { ref: 'feature-branch' },
      },
    },
  },
}));

jest.mock('@actions/glob', () => ({
  create: jest.fn(),
}));

jest.mock('../../src/auth/authenticationService', () => ({ AuthenticationService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../src/file/fileProcessor', () => ({ FileProcessor: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../src/api/purviewClient', () => ({ PurviewClient: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../src/payload/payloadBuilder', () => ({ PayloadBuilder: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../src/runner/fullScanService', () => ({ FullScanService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../src/utils/blockDetector', () => ({ isBlocked: jest.fn(), getBlockingActions: jest.fn() }));
jest.mock('../../src/utils/prCommentService', () => ({ PrCommentService: jest.fn().mockImplementation(() => ({})) }));

import * as github from '@actions/github';
import { GitHubActionsRunner } from '../../src/runner/gitHubActionsRunner';
import { ActionConfig } from '../../src/config/types';

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
      owner: 'TestOwner',
      repo: 'TestRepo',
      branch: 'main',
      sha: 'abc123',
      runId: '999',
      runNumber: '1',
    },
    ...overrides,
  };
}

describe('GitHubActionsRunner', () => {
  let runner: GitHubActionsRunner;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env['GITHUB_TOKEN'] = 'fake-token';
    process.env['GITHUB_WORKFLOW_REF'] = 'TestOwner/TestRepo/.github/workflows/purview-scan.yml@refs/heads/main';
    runner = new GitHubActionsRunner(createConfig());
    mockListWorkflowRunsForRepo.mockReset();
    mockGetWorkflowRun.mockReset();
    // Default: getWorkflowRun returns current run with workflow_id 42
    mockGetWorkflowRun.mockResolvedValue({
      data: { workflow_id: 42 },
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('findLastProcessedCommitSha', () => {
    const callMethod = (commitShas: Set<string>) =>
      (runner as any).findLastProcessedCommitSha(commitShas);

    it('returns null when GITHUB_TOKEN is not set', async () => {
      delete process.env['GITHUB_TOKEN'];
      const result = await callMethod(new Set(['sha1']));
      expect(result).toBeNull();
      expect(mockGetWorkflowRun).not.toHaveBeenCalled();
      expect(mockListWorkflowRunsForRepo).not.toHaveBeenCalled();
    });

    it('returns null when workflow ID cannot be determined', async () => {
      delete process.env['GITHUB_WORKFLOW_REF'];
      (github.context as any).workflow = '';
      const result = await callMethod(new Set(['sha1']));
      expect(result).toBeNull();
      expect(mockGetWorkflowRun).not.toHaveBeenCalled();
      expect(mockListWorkflowRunsForRepo).not.toHaveBeenCalled();
    });

    it('resolves numeric workflow ID from current run', async () => {
      mockListWorkflowRunsForRepo.mockResolvedValue({
        data: { workflow_runs: [], total_count: 0 },
      });

      await callMethod(new Set(['sha1']));

      // Should get workflow run to resolve numeric ID
      expect(mockGetWorkflowRun).toHaveBeenCalledWith(
        expect.objectContaining({ run_id: 999 })
      );
      // listWorkflowRunsForRepo is called (no workflow_id param — filtered client-side)
      expect(mockListWorkflowRunsForRepo).toHaveBeenCalled();
    });

    it('still works without GITHUB_WORKFLOW_REF', async () => {
      delete process.env['GITHUB_WORKFLOW_REF'];
      (github.context as any).workflow = 'My Workflow';
      mockListWorkflowRunsForRepo.mockResolvedValue({
        data: { workflow_runs: [], total_count: 0 },
      });

      await callMethod(new Set(['sha1']));

      // Falls back to context.workflow for the workflowId string, but
      // resolves numeric ID from the current run regardless
      expect(mockGetWorkflowRun).toHaveBeenCalledTimes(1);
      expect(mockListWorkflowRunsForRepo).toHaveBeenCalled();
    });

    it('passes branch from PR payload', async () => {
      mockListWorkflowRunsForRepo.mockResolvedValue({
        data: { workflow_runs: [], total_count: 0 },
      });

      await callMethod(new Set(['sha1']));

      expect(mockListWorkflowRunsForRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: 'feature-branch',
        })
      );
    });

    it('returns matching head_sha from first page', async () => {
      mockListWorkflowRunsForRepo.mockResolvedValue({
        data: {
          total_count: 5,
          workflow_runs: [
            { id: 1, head_sha: 'sha-other', workflow_id: 42 },
            { id: 2, head_sha: 'sha-match', workflow_id: 42 },
            { id: 3, head_sha: 'sha-old', workflow_id: 42 },
          ],
        },
      });

      const result = await callMethod(new Set(['sha-match', 'sha-newer']));

      expect(result).toBe('sha-match');
      expect(mockListWorkflowRunsForRepo).toHaveBeenCalledTimes(1);
    });

    it('paginates to find matching SHA on later page', async () => {
      mockListWorkflowRunsForRepo
        .mockResolvedValueOnce({
          data: {
            total_count: 6,
            workflow_runs: [
              { id: 1, head_sha: 'sha-a', workflow_id: 42 },
              { id: 2, head_sha: 'sha-b', workflow_id: 42 },
              { id: 3, head_sha: 'sha-c', workflow_id: 42 },
            ],
          },
        })
        .mockResolvedValueOnce({
          data: {
            total_count: 6,
            workflow_runs: [
              { id: 4, head_sha: 'sha-d', workflow_id: 42 },
              { id: 5, head_sha: 'sha-target', workflow_id: 42 },
              { id: 6, head_sha: 'sha-f', workflow_id: 42 },
            ],
          },
        });

      const result = await callMethod(new Set(['sha-target']));

      expect(result).toBe('sha-target');
      expect(mockListWorkflowRunsForRepo).toHaveBeenCalledTimes(2);
      expect(mockListWorkflowRunsForRepo).toHaveBeenNthCalledWith(1, expect.objectContaining({ page: 1 }));
      expect(mockListWorkflowRunsForRepo).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2 }));
    });

    it('returns null when no runs match', async () => {
      mockListWorkflowRunsForRepo.mockResolvedValue({
        data: {
          total_count: 2,
          workflow_runs: [
            { id: 1, head_sha: 'sha-x', workflow_id: 42 },
            { id: 2, head_sha: 'sha-y', workflow_id: 42 },
          ],
        },
      });

      const result = await callMethod(new Set(['sha-not-in-history']));

      expect(result).toBeNull();
    });

    it('returns null when there are no workflow runs at all', async () => {
      mockListWorkflowRunsForRepo.mockResolvedValue({
        data: { total_count: 0, workflow_runs: [] },
      });

      const result = await callMethod(new Set(['sha1']));

      expect(result).toBeNull();
    });

    it('stops paginating when all runs have been fetched', async () => {
      mockListWorkflowRunsForRepo
        .mockResolvedValueOnce({
          data: {
            total_count: 4,
            workflow_runs: [
              { id: 1, head_sha: 'sha-a', workflow_id: 42 },
              { id: 2, head_sha: 'sha-b', workflow_id: 42 },
              { id: 3, head_sha: 'sha-c', workflow_id: 42 },
            ],
          },
        })
        .mockResolvedValueOnce({
          data: {
            total_count: 4,
            workflow_runs: [
              { id: 4, head_sha: 'sha-d', workflow_id: 42 },
            ],
          },
        });

      const result = await callMethod(new Set(['sha-not-found']));

      expect(result).toBeNull();
      expect(mockListWorkflowRunsForRepo).toHaveBeenCalledTimes(2);
    });

    it('returns null and logs permission message on 404', async () => {
      const httpError = new Error('Not Found') as any;
      httpError.status = 404;
      httpError.name = 'HttpError';
      mockListWorkflowRunsForRepo.mockRejectedValue(httpError);

      const result = await callMethod(new Set(['sha1']));

      expect(result).toBeNull();
    });

    it('returns null on non-404 errors', async () => {
      mockListWorkflowRunsForRepo.mockRejectedValue(new Error('Network timeout'));

      const result = await callMethod(new Set(['sha1']));

      expect(result).toBeNull();
    });

    it('returns null when getWorkflowRun fails', async () => {
      mockGetWorkflowRun.mockRejectedValue(new Error('API error'));

      const result = await callMethod(new Set(['sha1']));

      expect(result).toBeNull();
      expect(mockListWorkflowRunsForRepo).not.toHaveBeenCalled();
    });

    it('uses per_page of 10', async () => {
      mockListWorkflowRunsForRepo.mockResolvedValue({
        data: { total_count: 0, workflow_runs: [] },
      });

      await callMethod(new Set(['sha1']));

      expect(mockListWorkflowRunsForRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          per_page: 10,
        })
      );
    });

    it('passes correct owner and repo from config', async () => {
      mockListWorkflowRunsForRepo.mockResolvedValue({
        data: { total_count: 0, workflow_runs: [] },
      });

      await callMethod(new Set(['sha1']));

      expect(mockListWorkflowRunsForRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'TestOwner',
          repo: 'TestRepo',
        })
      );
    });

    it('filters runs by workflow_id client-side', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        data: { workflow_id: 77 },
      });
      mockListWorkflowRunsForRepo.mockResolvedValue({
        data: {
          total_count: 3,
          workflow_runs: [
            { id: 1, head_sha: 'sha-other-wf', workflow_id: 99 },
            { id: 2, head_sha: 'sha-match', workflow_id: 77 },
            { id: 3, head_sha: 'sha-another-wf', workflow_id: 50 },
          ],
        },
      });

      const result = await callMethod(new Set(['sha-match']));

      // Should match sha-match because it belongs to workflow 77
      expect(result).toBe('sha-match');
      // listWorkflowRunsForRepo is called without workflow_id in params
      expect(mockListWorkflowRunsForRepo).toHaveBeenCalledWith(
        expect.not.objectContaining({ workflow_id: expect.anything() })
      );
    });

    it('skips runs from other workflows when filtering', async () => {
      mockListWorkflowRunsForRepo.mockResolvedValue({
        data: {
          total_count: 3,
          workflow_runs: [
            { id: 1, head_sha: 'sha-target', workflow_id: 99 },
            { id: 2, head_sha: 'sha-other', workflow_id: 42 },
            { id: 3, head_sha: 'sha-third', workflow_id: 50 },
          ],
        },
      });

      // sha-target exists in the set but belongs to workflow 99, not 42
      const result = await callMethod(new Set(['sha-target']));

      expect(result).toBeNull();
    });
  });
});
