"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.postToPurview = postToPurview;
const axios_1 = __importDefault(require("axios"));
async function postToPurview(payload, token, config, logger, maxRetries = 3) {
    const groupId = payload.messageGroups?.[0]?.messageGroupId ?? null;
    logger.startGroup(`Submitting Batch to Purview API (Group ID: ${groupId})`);
    logger.debug(`Endpoint: ${config.endpoint}`);
    logger.debug(`Payload contains ${payload.messageGroups[0]?.messages?.length ?? 0} messages.`);
    if (config.debug) {
        // Stringify with a replacer to handle potential circular references safely
        const cache = new Set();
        const payloadString = JSON.stringify(payload, (_key, value) => {
            if (typeof value === 'object' && value !== null) {
                if (cache.has(value))
                    return '[Circular]';
                cache.add(value);
            }
            return value;
        }, 2);
        logger.debug(`Payload content: ${payloadString}`);
    }
    let attempt = 0;
    while (attempt < maxRetries) {
        attempt++;
        logger.info(`Attempting to POST to Purview API (Attempt ${attempt}/${maxRetries})...`);
        try {
            const startTime = Date.now();
            const response = await axios_1.default.post(config.endpoint, payload, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json; charset=utf-8',
                },
                timeout: 60000, // 60 second timeout
            });
            const duration = Date.now() - startTime;
            logger.info(`API call successful. Status: ${response.status} ${response.statusText}. Duration: ${duration}ms`);
            logger.endGroup();
            return { success: true, groupId };
        }
        catch (error) {
            const axiosError = error;
            if (axiosError.response) {
                logger.error(`HTTP Error: ${axiosError.response.status} ${axiosError.response.statusText}`);
                logger.error(`Response Body: ${JSON.stringify(axiosError.response.data)}`);
                // Do not retry on 4xx client errors (except 429 which we might later)
                if (axiosError.response.status >= 400 && axiosError.response.status < 500) {
                    if (config.failOnNon2xx) {
                        throw new Error(`Purview API returned a client error: ${axiosError.response.status}`);
                    }
                    logger.endGroup();
                    return { success: false, groupId };
                }
            }
            else if (axiosError.request) {
                logger.error('Network Error: No response received from Purview endpoint. Check connectivity and endpoint URL.');
            }
            else {
                logger.error(`Request Setup Error: ${axiosError.message}`);
            }
            if (attempt >= maxRetries) {
                break; // Exit loop if max retries reached
            }
            const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
            logger.info(`Retrying in ${delay / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    logger.error('Max retries reached. Aborting submission.');
    logger.endGroup();
    if (config.failOnNon2xx) {
        throw new Error('Failed to send data to Purview after multiple retries.');
    }
    return { success: false, groupId };
}
//# sourceMappingURL=client.js.map