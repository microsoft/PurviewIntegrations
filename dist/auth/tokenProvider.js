import * as exec from '@actions/exec';
export async function getScopedToken(resource, tenantId, logger) {
    logger.info(`Attempting to acquire Azure AD token for resource: ${resource}`);
    const args = [
        'account',
        'get-access-token',
        '--resource',
        resource,
        '--tenant',
        tenantId,
        '--query',
        'accessToken',
        '-o',
        'tsv'
    ];
    let accessToken = '';
    let errorOutput = '';
    const options = {
        silent: true,
        listeners: {
            stdout: (data) => {
                accessToken += data.toString();
            },
            stderr: (data) => {
                errorOutput += data.toString();
            },
        },
    };
    try {
        const exitCode = await exec.exec('az', args, options);
        if (exitCode !== 0) {
            throw new Error(`az CLI exited with code ${exitCode}`);
        }
    }
    catch (error) {
        logger.error('Failed to execute `az account get-access-token`.');
        logger.error(`Error output: ${errorOutput}`);
        throw new Error('Azure token acquisition failed. Ensure you are logged in via `azure/login` with OIDC and the correct permissions are configured.');
    }
    const token = accessToken.trim();
    if (!token) {
        logger.error('`az account get-access-token` executed but returned an empty token.');
        logger.error(`Error output from az CLI: ${errorOutput}`);
        throw new Error('Acquired token is empty.');
    }
    logger.info('Successfully acquired Azure AD token.');
    return token;
}
//# sourceMappingURL=tokenProvider.js.map