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
    private sendContentActivities;
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