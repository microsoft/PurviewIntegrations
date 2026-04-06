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

import { PrCommentService } from '../../src/utils/prCommentService';
import { BlockedFileResult } from '../../src/config/types';

describe('PrCommentService', () => {
  const mockCreateReview = jest.fn();
  const mockOctokit = {
    rest: {
      pulls: {
        createReview: mockCreateReview,
      },
    },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateReview.mockResolvedValue({});
  });

  it('does nothing when blockedFiles is empty', async () => {
    const service = new PrCommentService(mockOctokit, 'owner', 'repo', 42);
    await service.postBlockedFilesReview([]);
    expect(mockCreateReview).not.toHaveBeenCalled();
  });

  it('posts review comment with blocked file details', async () => {
    const service = new PrCommentService(mockOctokit, 'testOwner', 'testRepo', 7);
    const blockedFiles: BlockedFileResult[] = [
      {
        filePath: 'src/secrets.ts',
        userId: 'user-1',
        policyActions: [
          { action: 'blockAccess', policyName: 'Credit Card Policy', policyId: 'p1' },
        ],
      },
    ];

    await service.postBlockedFilesReview(blockedFiles);

    expect(mockCreateReview).toHaveBeenCalledTimes(1);
    const call = mockCreateReview.mock.calls[0][0];
    expect(call.owner).toBe('testOwner');
    expect(call.repo).toBe('testRepo');
    expect(call.pull_number).toBe(7);
    expect(call.event).toBe('COMMENT');
    expect(call.body).toContain('Purview Data Security');
    expect(call.body).toContain('src/secrets.ts');
    expect(call.body).toContain('blockAccess');
    expect(call.body).not.toContain('Policy');
  });

  it('includes multiple files and actions in the table', async () => {
    const service = new PrCommentService(mockOctokit, 'o', 'r', 1);
    const blockedFiles: BlockedFileResult[] = [
      {
        filePath: 'file1.txt',
        userId: 'u1',
        policyActions: [
          { action: 'blockAccess', policyName: 'Policy-A', policyId: 'pid-A' },
          { action: 'restrict', restrictionAction: 'block', policyName: 'Policy-B', policyId: 'pid-B' },
        ],
      },
      {
        filePath: 'file2.txt',
        userId: 'u2',
        policyActions: [
          { action: 'blockAccess', policyId: 'pid-1' },
        ],
      },
    ];

    await service.postBlockedFilesReview(blockedFiles);

    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('file1.txt');
    expect(body).toContain('file2.txt');
    expect(body).toContain('blockAccess');
    expect(body).toContain('block');
    expect(body).not.toContain('pid-A');
    expect(body).not.toContain('pid-B');
    expect(body).not.toContain('pid-1');
  });

  it('re-throws error when createReview fails', async () => {
    const service = new PrCommentService(mockOctokit, 'o', 'r', 1);
    mockCreateReview.mockRejectedValue(new Error('API failure'));

    await expect(
      service.postBlockedFilesReview([
        {
          filePath: 'fail.txt',
          userId: 'u1',
          policyActions: [{ action: 'blockAccess' }],
        },
      ])
    ).rejects.toThrow('API failure');
  });
});
