import * as github from '@actions/github';
import { Logger } from '../utils/logger';

export interface StateRepo {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

export interface StateFileLookup {
  exists: boolean;
  sha?: string;
}

export class StateService {
  private readonly logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? new Logger('StateService');
  }

  static defaultStatePathForTarget(targetOwner: string, targetRepo: string): string {
    const safeOwner = targetOwner.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const safeRepo = targetRepo.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return `.purview/state/${safeOwner}-${safeRepo}.json`;
  }

  async lookupStateFile(stateRepo: StateRepo, path: string): Promise<StateFileLookup> {
    const octokit = github.getOctokit(stateRepo.token);

    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: stateRepo.owner,
        repo: stateRepo.repo,
        path,
        ref: stateRepo.branch,
      });

      if (Array.isArray(data) || !('sha' in data)) {
        return { exists: true };
      }

      return { exists: true, sha: data.sha };
    } catch (e: any) {
      // GitHub API returns 404 when the file doesn't exist.
      if (e?.status === 404) {
        return { exists: false };
      }

      throw e;
    }
  }

  async writeStateFile(stateRepo: StateRepo, path: string, state: unknown, message: string): Promise<void> {
    const octokit = github.getOctokit(stateRepo.token);

    const content = Buffer.from(JSON.stringify(state, null, 2), 'utf8').toString('base64');
    const lookup = await this.lookupStateFile(stateRepo, path);

    await octokit.rest.repos.createOrUpdateFileContents({
      owner: stateRepo.owner,
      repo: stateRepo.repo,
      path,
      message,
      content,
      branch: stateRepo.branch,
      sha: lookup.sha,
    });

    this.logger.info(`State marker written to ${stateRepo.owner}/${stateRepo.repo}:${path} (${stateRepo.branch})`);
  }
}
