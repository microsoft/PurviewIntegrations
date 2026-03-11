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
}
//# sourceMappingURL=gitHubActionsRunner.d.ts.map