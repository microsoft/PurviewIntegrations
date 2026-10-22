import * as core from '@actions/core';
import { GitHubActionsRunner } from './runner/gitHubActionsRunner';
import { validateInputs } from './validation/inputValidator';
import { Logger } from './utils/logger';

async function run(): Promise<void> {
  const logger = new Logger('Main');
  
  try {
    const [major = 0, minor = 0, patch = 0] = process.versions.node.split('.').map(Number);
    if (major !== 24 || !Number.isInteger(patch) || minor < 22 || (minor === 22 && patch < 1)) {
      core.setFailed(
        `Node.js 24.22.1 or later in the 24.x line is required to address CVE-2026-111497; found ${process.versions.node}. ` +
        'Update the GitHub Actions runner and its bundled Node.js runtime. actions/setup-node does not update the runtime used by this action.'
      );
      return;
    }

    logger.info('Starting Purview GitHub Action');
    
    // Validate inputs early
    const config = await validateInputs();
    logger.debug('Configuration validated', { 
      purviewAccount: config.purviewAccountName,
      filePatterns: config.filePatterns 
    });
    
    // Initialize and run the action
    const runner = new GitHubActionsRunner(config);
    await runner.execute();
    
    logger.info('Purview GitHub Action completed successfully');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    logger.error('Action failed', { error: errorMessage });
    core.setFailed(errorMessage);
  }
}

// Execute the action
run();