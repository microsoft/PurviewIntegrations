import { BlockedFileResult } from '../config/types';
/**
 * Posts PR review comments when ProcessContent returns block actions.
 */
export declare class PrCommentService {
    private readonly octokit;
    private readonly owner;
    private readonly repo;
    private readonly prNumber;
    private readonly logger;
    constructor(octokit: ReturnType<typeof import('@actions/github').getOctokit>, owner: string, repo: string, prNumber: number);
    /**
     * Post a review comment on the PR listing all blocked files with policy details.
     */
    postBlockedFilesReview(blockedFiles: BlockedFileResult[]): Promise<void>;
    private formatBlockedFilesComment;
}
//# sourceMappingURL=prCommentService.d.ts.map