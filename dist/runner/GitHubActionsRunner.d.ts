import { ActionConfig } from '../config/types';
export declare class GitHubActionsRunner {
    private readonly config;
    private readonly logger;
    private readonly authService;
    private readonly fileProcessor;
    private readonly purviewClient;
    private readonly payloadBuilder;
    private readonly fullScanService;
    constructor(config: ActionConfig);
    execute(): Promise<void>;
    /**
     * Return the SHA that marks the boundary between "history" (for full scan)
     * and "current event" (for diff path).
     * - push: payload.before (the parent of the first pushed commit)
     * - pull_request: the PR base SHA
     * - workflow_dispatch / other: undefined (no boundary — full scan gets everything)
     */
    private resolveCurrentEventBoundarySha;
    private processDiffPath;
    private processCommitGroup;
    private processUserFiles;
    private processFilesInline;
    private processFilesOffline;
    /**
     * Resolve user protection scopes using the cache. Returns the PS response
     * and etag, or null if the caller should fall back to contentActivities.
     */
    private resolveUserPsWithCache;
    /**
     * Send a commit-level request through the same routing as file requests.
     */
    private sendCommitRequest;
    private sendContentActivities;
    private sendCommitContentActivity;
    /**
     * Post a notification about blocked files — PR review comment for pull_request
     * events, commit comment for push events.
     */
    private postBlockedFilesNotification;
    private formatBlockedFilesComment;
    private createSummary;
    /**
     * Paginates through successful workflow runs in batches of 3, checking each
     * run's head_sha against the known PR commit SHAs. Returns the first match
     * (i.e. the most recent successfully processed commit), or null if none found.
     */
    private findLastProcessedCommitSha;
    /**
     * Resolves the numeric workflow ID by inspecting the current workflow run.
     */
    private resolveWorkflowId;
}
//# sourceMappingURL=gitHubActionsRunner.d.ts.map