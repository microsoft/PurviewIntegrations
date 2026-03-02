import * as core from '@actions/core';
import { GitHubActionsRunner } from './runner/gitHubActionsRunner';
import { validateInputs } from './validation/inputValidator';
import { Logger } from './utils/logger';

async function run(): Promise<void> {
  const logger = new Logger('Main');
  
  try {
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