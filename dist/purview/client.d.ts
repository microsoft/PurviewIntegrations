import { Logger } from '../utils/logger';
import { ActionConfig, PurviewPayload } from '../utils/types';
export declare function postToPurview(payload: PurviewPayload, token: string, config: ActionConfig, logger: Logger, maxRetries?: number): Promise<{
    success: boolean;
    groupId: string | null;
}>;
//# sourceMappingURL=client.d.ts.map