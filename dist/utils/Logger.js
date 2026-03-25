import * as core from '@actions/core';
export var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["DEBUG"] = 0] = "DEBUG";
    LogLevel[LogLevel["INFO"] = 1] = "INFO";
    LogLevel[LogLevel["WARNING"] = 2] = "WARNING";
    LogLevel[LogLevel["ERROR"] = 3] = "ERROR";
})(LogLevel || (LogLevel = {}));
export class Logger {
    context;
    isDebug;
    constructor(context) {
        this.context = context;
        this.isDebug = core.getBooleanInput('debug') || process.env['RUNNER_DEBUG'] === '1';
    }
    debug(message, data) {
        if (this.isDebug) {
            const logMessage = this.formatMessage(LogLevel.DEBUG, message, data);
            // Use core.info so debug output is always visible in the Actions log
            // when the user has enabled the debug input. core.debug only shows
            // when the ACTIONS_STEP_DEBUG repo secret is set.
            core.info(logMessage);
        }
    }
    info(message, data) {
        const logMessage = this.formatMessage(LogLevel.INFO, message, data);
        core.info(logMessage);
    }
    warn(message, data) {
        const logMessage = this.formatMessage(LogLevel.WARNING, message, data);
        core.warning(logMessage);
    }
    warning(message, data) {
        this.warn(message, data);
    }
    error(message, data) {
        const logMessage = this.formatMessage(LogLevel.ERROR, message, data);
        core.error(logMessage);
    }
    startGroup(name) {
        core.startGroup(name);
    }
    endGroup() {
        core.endGroup();
    }
    formatMessage(level, message, data) {
        const timestamp = new Date().toISOString();
        const levelStr = LogLevel[level];
        const sanitizedData = data ? this.sanitizeData(data) : '';
        return `[${timestamp}] [${levelStr}] [${this.context}] ${message}${sanitizedData ? ' ' + sanitizedData : ''}`;
    }
    sanitizeData(data) {
        try {
            // Remove sensitive information
            const sanitized = this.removeSensitiveData(data);
            return JSON.stringify(sanitized, null, 2);
        }
        catch (error) {
            return '[Unable to serialize data]';
        }
    }
    removeSensitiveData(obj) {
        if (typeof obj !== 'object' || obj === null) {
            return obj;
        }
        const sensitiveKeys = [
            'token', 'password', 'secret', 'key', 'authorization',
            'client_secret', 'access_token', 'refresh_token'
        ];
        const cleaned = Array.isArray(obj) ? [...obj] : { ...obj };
        for (const key in cleaned) {
            const lowerKey = key.toLowerCase();
            if (sensitiveKeys.some(sensitive => lowerKey.includes(sensitive))) {
                cleaned[key] = '[REDACTED]';
            }
            else if (typeof cleaned[key] === 'object') {
                cleaned[key] = this.removeSensitiveData(cleaned[key]);
            }
        }
        return cleaned;
    }
}
//# sourceMappingURL=logger.js.map