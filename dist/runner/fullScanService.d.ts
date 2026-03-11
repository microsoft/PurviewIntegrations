import { ActionConfig, StateTrackingInfo } from '../config/types';
import { FileProcessor } from '../file/fileProcessor';
import { PurviewClient } from '../api/purviewClient';
import { PayloadBuilder } from '../payload/payloadBuilder';
export declare class FullScanService {
    private readonly config;
    private readonly fileProcessor;
    private readonly purviewClient;
    private readonly payloadBuilder;
    private readonly logger;
    private readonly stateService;
    constructor(config: ActionConfig, fileProcessor: FileProcessor, purviewClient: PurviewClient, payloadBuilder: PayloadBuilder);
    /**
     * Sets up state tracking configuration and determines if this is the first run
     */
    setupStateTrackingAndDetectFirstRun(): Promise<{
        stateTrackingEnabled: boolean;
        firstRun: boolean;
        stateInfo?: StateTrackingInfo;
    }>;
    /**
     * Performs a full repository scan when it's the first run
     */
    performFullScan(stateInfo: StateTrackingInfo | undefined, failedPayloads: string[], prInfo: any, userPsDeniedCache: Set<string>): Promise<number>;
    private resolveDefaultBranch;
    private ensureBranchExists;
    private detectFirstRun;
    private detectFirstRunFromWorkflowHistory;
    private processFilesByUser;
    private writeStateMarker;
    private sendContentActivities;
}
//# sourceMappingURL=fullScanService.d.ts.map