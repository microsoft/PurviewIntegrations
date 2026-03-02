import { UsersConfig } from '../config/types';
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
export declare class UserResolver {
    private readonly emailToUserId;
    private readonly defaultUserId;
    private readonly logger;
    constructor(usersConfig: UsersConfig, logger?: Logger);
    /**
     * Resolve an email address to an Azure AD user ID.
     * Returns the mapped userId if found, otherwise the defaultUserId.
     * Logs which value was chosen.
     */
    resolve(email: string | null | undefined): string;
    /**
     * Load and parse a users.json file from the given path.
     * Throws if the file is missing or malformed.
     */
    static loadFromFile(filePath: string, logger?: Logger): UserResolver;
}
//# sourceMappingURL=userResolver.d.ts.map