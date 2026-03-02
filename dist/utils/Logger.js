"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = exports.LogLevel = void 0;
const core = __importStar(require("@actions/core"));
var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["DEBUG"] = 0] = "DEBUG";
    LogLevel[LogLevel["INFO"] = 1] = "INFO";
    LogLevel[LogLevel["WARNING"] = 2] = "WARNING";
    LogLevel[LogLevel["ERROR"] = 3] = "ERROR";
})(LogLevel || (exports.LogLevel = LogLevel = {}));
class Logger {
    context;
    isDebug;
    constructor(context) {
        this.context = context;
        this.isDebug = core.getBooleanInput('debug') || process.env['RUNNER_DEBUG'] === '1';
    }
    debug(message, data) {
        if (this.isDebug) {
            const logMessage = this.formatMessage(LogLevel.DEBUG, message, data);
            core.debug(logMessage);
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
exports.Logger = Logger;
//# sourceMappingURL=logger.js.map