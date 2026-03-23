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

const mockListWorkflowRuns = jest.fn();
const mockListRepoWorkflows = jest.fn();

jest.mock('@actions/github', () => ({
  getOctokit: jest.fn(() => ({
    rest: {
      actions: {
        listWorkflowRuns: mockListWorkflowRuns,
        listRepoWorkflows: mockListRepoWorkflows,
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
    mockListWorkflowRuns.mockReset();
    mockListRepoWorkflows.mockReset();
    // Default: listRepoWorkflows returns a matching workflow with numeric ID 42
    mockListRepoWorkflows.mockResolvedValue({
      data: {
        total_count: 1,
        workflows: [{ id: 42, path: '.github/workflows/purview-scan.yml' }],
      },
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
      expect(mockListRepoWorkflows).not.toHaveBeenCalled();
      expect(mockListWorkflowRuns).not.toHaveBeenCalled();
    });

    it('returns null when workflow ID cannot be determined', async () => {
      delete process.env['GITHUB_WORKFLOW_REF'];
      (github.context as any).workflow = '';
      const result = await callMethod(new Set(['sha1']));
      expect(result).toBeNull();
      expect(mockListRepoWorkflows).not.toHaveBeenCalled();
      expect(mockListWorkflowRuns).not.toHaveBeenCalled();
    });

    it('extracts workflow filename from GITHUB_WORKFLOW_REF', async () => {
      mockListWorkflowRuns.mockResolvedValue({
        data: { workflow_runs: [], total_count: 0 },
      });

      await callMethod(new Set(['sha1']));

      // Should resolve filename then use numeric ID
      expect(mockListRepoWorkflows).toHaveBeenCalledTimes(1);
      expect(mockListWorkflowRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          workflow_id: 42,
        })
      );
    });

    it('uses github.context.workflow as fallback for workflow ID', async () => {
      delete process.env['GITHUB_WORKFLOW_REF'];
      (github.context as any).workflow = 'My Workflow';
      mockListRepoWorkflows.mockResolvedValue({
        data: {
          total_count: 1,
          workflows: [{ id: 99, path: 'My Workflow' }],
        },
      });
      mockListWorkflowRuns.mockResolvedValue({
        data: { workflow_runs: [], total_count: 0 },
      });

      await callMethod(new Set(['sha1']));

      expect(mockListWorkflowRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          workflow_id: 99,
        })
      );
    });

    it('passes branch from PR payload', async () => {
      mockListWorkflowRuns.mockResolvedValue({
        data: { workflow_runs: [], total_count: 0 },
      });

      await callMethod(new Set(['sha1']));

      expect(mockListWorkflowRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: 'feature-branch',
        })
      );
    });

    it('returns matching head_sha from first page', async () => {
      mockListWorkflowRuns.mockResolvedValue({
        data: {
          total_count: 5,
          workflow_runs: [
            { id: 1, head_sha: 'sha-other' },
            { id: 2, head_sha: 'sha-match' },
            { id: 3, head_sha: 'sha-old' },
          ],
        },
      });

      const result = await callMethod(new Set(['sha-match', 'sha-newer']));

      expect(result).toBe('sha-match');
      expect(mockListWorkflowRuns).toHaveBeenCalledTimes(1);
    });

    it('paginates to find matching SHA on later page', async () => {
      mockListWorkflowRuns
        .mockResolvedValueOnce({
          data: {
            total_count: 6,
            workflow_runs: [
              { id: 1, head_sha: 'sha-a' },
              { id: 2, head_sha: 'sha-b' },
              { id: 3, head_sha: 'sha-c' },
            ],
          },
        })
        .mockResolvedValueOnce({
          data: {
            total_count: 6,
            workflow_runs: [
              { id: 4, head_sha: 'sha-d' },
              { id: 5, head_sha: 'sha-target' },
              { id: 6, head_sha: 'sha-f' },
            ],
          },
        });

      const result = await callMethod(new Set(['sha-target']));

      expect(result).toBe('sha-target');
      expect(mockListWorkflowRuns).toHaveBeenCalledTimes(2);
      expect(mockListWorkflowRuns).toHaveBeenNthCalledWith(1, expect.objectContaining({ page: 1 }));
      expect(mockListWorkflowRuns).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2 }));
    });

    it('returns null when no runs match', async () => {
      mockListWorkflowRuns.mockResolvedValue({
        data: {
          total_count: 2,
          workflow_runs: [
            { id: 1, head_sha: 'sha-x' },
            { id: 2, head_sha: 'sha-y' },
          ],
        },
      });

      const result = await callMethod(new Set(['sha-not-in-history']));

      expect(result).toBeNull();
    });

    it('returns null when there are no workflow runs at all', async () => {
      mockListWorkflowRuns.mockResolvedValue({
        data: { total_count: 0, workflow_runs: [] },
      });

      const result = await callMethod(new Set(['sha1']));

      expect(result).toBeNull();
    });

    it('stops paginating when all runs have been fetched', async () => {
      mockListWorkflowRuns
        .mockResolvedValueOnce({
          data: {
            total_count: 4,
            workflow_runs: [
              { id: 1, head_sha: 'sha-a' },
              { id: 2, head_sha: 'sha-b' },
              { id: 3, head_sha: 'sha-c' },
            ],
          },
        })
        .mockResolvedValueOnce({
          data: {
            total_count: 4,
            workflow_runs: [
              { id: 4, head_sha: 'sha-d' },
            ],
          },
        });

      const result = await callMethod(new Set(['sha-not-found']));

      expect(result).toBeNull();
      expect(mockListWorkflowRuns).toHaveBeenCalledTimes(2);
    });

    it('returns null and logs permission message on 404', async () => {
      const httpError = new Error('Not Found') as any;
      httpError.status = 404;
      httpError.name = 'HttpError';
      mockListWorkflowRuns.mockRejectedValue(httpError);

      const result = await callMethod(new Set(['sha1']));

      expect(result).toBeNull();
    });

    it('returns null on non-404 errors', async () => {
      mockListWorkflowRuns.mockRejectedValue(new Error('Network timeout'));

      const result = await callMethod(new Set(['sha1']));

      expect(result).toBeNull();
    });

    it('returns null when workflow is not found in repo', async () => {
      mockListRepoWorkflows.mockResolvedValue({
        data: { total_count: 0, workflows: [] },
      });

      const result = await callMethod(new Set(['sha1']));

      expect(result).toBeNull();
      expect(mockListWorkflowRuns).not.toHaveBeenCalled();
    });

    it('uses per_page of 3', async () => {
      mockListWorkflowRuns.mockResolvedValue({
        data: { total_count: 0, workflow_runs: [] },
      });

      await callMethod(new Set(['sha1']));

      expect(mockListWorkflowRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          per_page: 3,
        })
      );
    });

    it('passes correct owner and repo from config', async () => {
      mockListWorkflowRuns.mockResolvedValue({
        data: { total_count: 0, workflow_runs: [] },
      });

      await callMethod(new Set(['sha1']));

      expect(mockListWorkflowRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'TestOwner',
          repo: 'TestRepo',
        })
      );
    });

    it('uses numeric workflow ID in listWorkflowRuns call', async () => {
      mockListRepoWorkflows.mockResolvedValue({
        data: {
          total_count: 2,
          workflows: [
            { id: 10, path: '.github/workflows/other.yml' },
            { id: 42, path: '.github/workflows/purview-scan.yml' },
          ],
        },
      });
      mockListWorkflowRuns.mockResolvedValue({
        data: { total_count: 0, workflow_runs: [] },
      });

      await callMethod(new Set(['sha1']));

      expect(mockListWorkflowRuns).toHaveBeenCalledWith(
        expect.objectContaining({ workflow_id: 42 })
      );
    });
  });
});
