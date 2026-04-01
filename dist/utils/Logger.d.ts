export declare enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARNING = 2,
    ERROR = 3
}
export declare class Logger {
    private readonly context;
    private readonly isDebug;
    constructor(context: string);
    debug(message: string, data?: any): void;
    info(message: string, data?: any): void;
    warn(message: string, data?: any): void;
    warning(message: string, data?: any): void;
    error(message: string, data?: any): void;
    startGroup(name: string): void;
    endGroup(): void;
    private formatMessage;
    private sanitizeData;
    private jsonReplacer;
    private removeSensitiveData;
}
//# sourceMappingURL=logger.d.ts.map