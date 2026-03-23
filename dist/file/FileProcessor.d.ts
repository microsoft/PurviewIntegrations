import { ActionConfig, FileMetadata, PrInfo, CommitInfo, CommitFiles } from '../config/types';
export declare class FileProcessor {
    private readonly config;
    private readonly logger;
    private readonly octokit;
    private readonly purviewClient;
    private readonly authService;
    private emptySha;
    /** Cache: email (lowercase) → Graph API user ID. Survives across calls. */
    private readonly graphUserIdCache;
    constructor(config: ActionConfig);
    /**
     * Resolve a set of author emails to user IDs.
     * Resolution order: users.json mappings → cached Graph results → Graph API.
     * Results from Graph API are cached for the lifetime of this FileProcessor.
     *
     * Returns a map of lowercase email → userId.
     */
    private resolveUserIds;
    private getGlobPatterns;
    private normalizeRepoPath;
    private shouldIncludePath;
    getChangedFiles(): Promise<string[]>;
    getAllRepoFiles(): Promise<FileMetadata[]>;
    /**
     * Use `git log` to build a map of file path → last commit author email.
     * Runs a single git command for all files to stay efficient.
     */
    private getFileAuthorEmails;
    getPrInfoForPush(): Promise<PrInfo>;
    getPrInfo(): Promise<PrInfo>;
    private getFilesForCommit;
    /**
     * Computes a unified diff for a file when the commit API omits the patch.
     * Fetches the file content at both the parent and current commits via the
     * GitHub Contents API, then produces a unified diff.
     */
    private computeDiff;
    /**
     * Fetches file content from the GitHub API at a specific ref.
     * Uses the Contents API for small files (≤1MB base64) and falls back to
     * the raw download URL for larger files.
     */
    private fetchFileContent;
    /**
     * Produces a unified diff string from two arrays of lines.
     * Uses a simple LCS-based approach to generate hunks matching standard
     * unified diff format (the same format GitHub returns in .patch).
     */
    private generateUnifiedDiff;
    /**
     * Computes unified-diff hunks from old and new line arrays.
     * Groups consecutive changes with up to 3 lines of context around each change.
     */
    private computeHunks;
    /**
     * Builds an edit script (sequence of equal/delete/insert operations)
     * from two arrays of lines using LCS-based diff.
     * For files exceeding a line count threshold, falls back to a simple
     * delete-all/insert-all to avoid excessive memory usage.
     */
    private buildEditScript;
    private isCommitEmpty;
    getCommits(): Promise<CommitInfo[]>;
    getAllPRCommits(): Promise<CommitInfo[]>;
    getFilesGroupedByCommit(lastProcessedHeadSha?: string | null): Promise<CommitFiles[]>;
    getLatestPushFiles(lastProcessedHeadSha?: string | null): Promise<FileMetadata[]>;
    private getPullRequestFiles;
    private getFilesFromPatterns;
}
//# sourceMappingURL=fileProcessor.d.ts.map