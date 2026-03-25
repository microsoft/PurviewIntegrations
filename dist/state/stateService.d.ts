import { Logger } from '../utils/logger';
export interface StateRepo {
    owner: string;
    repo: string;
    branch: string;
    token: string;
}
export interface StateFileLookup {
    exists: boolean;
    sha?: string;
}
export declare class StateService {
    private readonly logger;
    constructor(logger?: Logger);
    static defaultStatePathForTarget(targetOwner: string, targetRepo: string): string;
    readStateFile<T>(stateRepo: StateRepo, path: string): Promise<T | null>;
    lookupStateFile(stateRepo: StateRepo, path: string): Promise<StateFileLookup>;
    writeStateFile(stateRepo: StateRepo, path: string, state: unknown, message: string): Promise<void>;
}
//# sourceMappingURL=stateService.d.ts.map