"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RetryHandler = void 0;
const logger_1 = require("./logger");
class RetryHandler {
    logger;
    defaultOptions = {
        maxAttempts: 3,
        initialDelay: 1000,
        maxDelay: 30000,
        backoffFactor: 2,
        jitter: true
    };
    constructor() {
        this.logger = new logger_1.Logger('RetryHandler');
    }
    async executeWithRetry(operation, operationName, options) {
        const config = { ...this.defaultOptions, ...options };
        let lastError;
        for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
            try {
                this.logger.debug(`Executing ${operationName} (attempt ${attempt}/${config.maxAttempts})`);
                const result = await operation();
                if (attempt > 1) {
                    this.logger.info(`${operationName} succeeded after ${attempt} attempts`);
                }
                return result;
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                // Don't retry on non-retryable errors
                if (!this.isRetryableError(lastError)) {
                    this.logger.error(`Non-retryable error in ${operationName}`, { error: lastError.message });
                    throw lastError;
                }
                if (attempt < config.maxAttempts) {
                    const delay = this.calculateDelay(attempt, config);
                    this.logger.warning(`${operationName} failed (attempt ${attempt}/${config.maxAttempts}), retrying in ${delay}ms`, { error: lastError.message });
                    await this.sleep(delay);
                }
            }
        }
        this.logger.error(`${operationName} failed after ${config.maxAttempts} attempts`);
        throw lastError || new Error(`${operationName} failed after ${config.maxAttempts} attempts`);
    }
    isRetryableError(error) {
        const message = error.message.toLowerCase();
        // Network errors
        if (message.includes('network') ||
            message.includes('timeout') ||
            message.includes('econnreset') ||
            message.includes('econnrefused')) {
            return true;
        }
        // Rate limiting
        if (message.includes('rate limit') || message.includes('429')) {
            return true;
        }
        // Temporary server errors
        if (message.includes('500') ||
            message.includes('502') ||
            message.includes('503') ||
            message.includes('504')) {
            return true;
        }
        // Authentication errors are not retryable
        if (message.includes('401') || message.includes('authentication')) {
            return false;
        }
        // Permission errors are not retryable
        if (message.includes('403') || message.includes('forbidden')) {
            return false;
        }
        // Default to not retrying unknown errors
        return false;
    }
    calculateDelay(attempt, config) {
        let delay = config.initialDelay * Math.pow(config.backoffFactor, attempt - 1);
        // Apply jitter
        if (config.jitter) {
            const jitterFactor = 0.1; // 10% jitter
            const jitterAmount = delay * jitterFactor * (Math.random() * 2 - 1);
            delay += jitterAmount;
        }
        // Ensure delay doesn't exceed max delay
        delay = Math.min(delay, config.maxDelay);
        return Math.round(delay);
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
exports.RetryHandler = RetryHandler;
//# sourceMappingURL=retryHandler.js.map