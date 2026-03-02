import * as glob from '@actions/glob';
import { Logger } from '../utils/logger';
import { ActionConfig } from '../utils/types';

export async function getChangedFiles(config: ActionConfig, logger: Logger): Promise<string[]> {
  const changedFilesEnv = process.env.CHANGED_FILES;
  const patterns = [...config.includeGlobs, ...config.excludeGlobs.map(p => `!${p}`)];
  const globber = await glob.create(patterns.join('\n'));
  const allFilesMatchingGlobs = await globber.glob(); // This now correctly takes 0 arguments

  if (!changedFilesEnv) {
    logger.warn('CHANGED_FILES environment variable not set. This is expected for push events to a default branch or manual runs. Scanning all files matching globs.');
    logger.info(`Found ${allFilesMatchingGlobs.length} files matching glob patterns in the repository.`);
    return allFilesMatchingGlobs;
  }

  const changedFilesList = new Set(changedFilesEnv.split(' ').filter(Boolean));
  logger.debug(`Received ${changedFilesList.size} changed files from environment variable.`);

  // Find the intersection between all files matching the glob and the files that actually changed.
  const filteredFiles = allFilesMatchingGlobs.filter(file => changedFilesList.has(file));

  logger.info(`Found ${filteredFiles.length} changed files that match the include/exclude glob patterns.`);
  if (config.debug) {
      logger.debug(`Final list of files to process: \n${filteredFiles.join('\n')}`);
  }

  return filteredFiles;
}