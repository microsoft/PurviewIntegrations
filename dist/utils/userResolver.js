import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';
/**
 * Resolves Azure AD user IDs from a local users.json mapping file.
 *
 * The file is expected to live in the workflow-definition repo (e.g. PurviewWorkflow)
 * and is checked out into $GITHUB_WORKSPACE by actions/checkout.
 *
 * Format:
 * {
 *   "users": [{ "email": "user@contoso.com", "userId": "<azure-ad-guid>" }],
 *   "defaultUserId": "<fallback-guid>"
 * }
 */
export class UserResolver {
    emailToUserId;
    defaultUserId;
    logger;
    constructor(usersConfig, logger) {
        this.logger = logger ?? new Logger('UserResolver');
        this.emailToUserId = new Map();
        this.defaultUserId = usersConfig.defaultUserId;
        for (const mapping of usersConfig.users) {
            this.emailToUserId.set(mapping.email.toLowerCase(), mapping.userId);
        }
        this.logger.info(`UserResolver initialised with ${this.emailToUserId.size} mapping(s) and default userId: ${this.defaultUserId}`);
    }
    /**
     * Resolve an email address to an Azure AD user ID.
     * Returns the mapped userId if found, otherwise the defaultUserId.
     * Logs which value was chosen.
     */
    resolve(email) {
        if (email) {
            const userId = this.emailToUserId.get(email.toLowerCase());
            if (userId) {
                this.logger.info(`Resolved userId for email '${email}': ${userId} (from users.json mapping)`);
                return userId;
            }
        }
        this.logger.info(`No users.json mapping found for email '${email ?? 'unknown'}', using default userId: ${this.defaultUserId}`);
        return this.defaultUserId;
    }
    /**
     * Load and parse a users.json file from the given path.
     * Throws if the file is missing or malformed.
     */
    static loadFromFile(filePath, logger) {
        const log = logger ?? new Logger('UserResolver');
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(process.env['GITHUB_WORKSPACE'] || process.cwd(), filePath);
        log.info(`Loading users.json from: ${absolutePath}`);
        if (!fs.existsSync(absolutePath)) {
            throw new Error(`users.json not found at ${absolutePath}. Ensure the file exists in your workflow-definition repo and is accessible locally or via the GitHub API.`);
        }
        const raw = fs.readFileSync(absolutePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed.defaultUserId) {
            throw new Error('users.json must contain a "defaultUserId" field.');
        }
        if (!Array.isArray(parsed.users)) {
            throw new Error('users.json must contain a "users" array.');
        }
        return new UserResolver(parsed, log);
    }
}
//# sourceMappingURL=userResolver.js.map