export interface RetryOptions {
    maxAttempts?: number;
    initialDelay?: number;
    maxDelay?: number;
    backoffFactor?: number;
    jitter?: boolean;
}
export declare class RetryHandler {
    private readonly logger;
    private readonly defaultOptions;
    constructor();
    executeWithRetry<T>(operation: () => Promise<T>, operationName: string, options?: RetryOptions): Promise<T>;
    private isRetryableError;
    private calculateDelay;
    private sleep;
}
//# sourceMappingURL=retryHandler.d.ts.map