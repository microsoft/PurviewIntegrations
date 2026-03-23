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
    private isCommitEmpty;
    getCommits(): Promise<CommitInfo[]>;
    getAllPRCommits(): Promise<CommitInfo[]>;
    getFilesGroupedByCommit(lastProcessedHeadSha?: string | null): Promise<CommitFiles[]>;
    getLatestPushFiles(lastProcessedHeadSha?: string | null): Promise<FileMetadata[]>;
    private getPullRequestFiles;
    private getFilesFromPatterns;
}
//# sourceMappingURL=fileProcessor.d.ts.map