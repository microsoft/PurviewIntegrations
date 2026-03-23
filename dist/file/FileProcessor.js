import * as github from '@actions/github';
import * as glob from '@actions/glob';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import isBinaryPath from 'is-binary-path';
import { minimatch } from 'minimatch';
import { Logger } from '../utils/logger';
import { PurviewClient } from '../api/purviewClient';
import { AuthenticationService } from '../auth/authenticationService';
import { UserResolver } from '../utils/userResolver';
export class FileProcessor {
    config;
    logger;
    octokit;
    purviewClient;
    authService;
    emptySha = "0000000000000000000000000000000000000000";
    /** Cache: email (lowercase) → Graph API user ID. Survives across calls. */
    graphUserIdCache = new Map();
    constructor(config) {
        this.config = config;
        this.logger = new Logger('FileProcessor');
        const token = process.env['GITHUB_TOKEN'] || '';
        this.authService = new AuthenticationService(this.config);
        this.octokit = github.getOctokit(token);
        this.purviewClient = new PurviewClient(this.config);
    }
    /**
     * Resolve a set of author emails to user IDs.
     * Resolution order: users.json mappings → cached Graph results → Graph API.
     * Results from Graph API are cached for the lifetime of this FileProcessor.
     *
     * Returns a map of lowercase email → userId.
     */
    async resolveUserIds(emails) {
        const resolved = {};
        // 1. Resolve from users.json mappings
        if (this.config.userMappings && this.config.userMappings.length > 0) {
            const userResolver = new UserResolver({ users: this.config.userMappings, defaultUserId: this.config.userId }, this.logger);
            for (const email of emails) {
                const id = userResolver.resolve(email);
                resolved[email] = id;
            }
        }
        // 2. Fill from cache for emails still unresolved (or resolved to default)
        const needsGraph = [];
        for (const email of emails) {
            if (resolved[email] && resolved[email] !== this.config.userId) {
                continue; // already resolved via users.json
            }
            const cached = this.graphUserIdCache.get(email);
            if (cached) {
                resolved[email] = cached;
                this.logger.info(`Graph cache hit for '${email}': ${cached}`);
            }
            else {
                needsGraph.push(email);
            }
        }
        // 3. Call Graph API for the rest
        if (needsGraph.length > 0) {
            try {
                const token = await this.authService.getToken();
                this.purviewClient.setAuthToken(token.accessToken);
                const response = await this.purviewClient.getUserInfo(needsGraph);
                if (response.success && response.data) {
                    for (const user of response.data.value) {
                        const upn = user.userPrincipalName.toLowerCase();
                        this.graphUserIdCache.set(upn, user.id);
                        resolved[upn] = user.id;
                        this.logger.info(`Graph API resolved '${upn}': ${user.id}`);
                    }
                }
                // Cache "not found" for emails that were queried but not in the response
                // so we don't call Graph API again for these users
                for (const email of needsGraph) {
                    if (!this.graphUserIdCache.has(email.toLowerCase())) {
                        this.graphUserIdCache.set(email.toLowerCase(), this.config.userId);
                        this.logger.info(`Graph API: user '${email}' not found, caching as default userId`);
                    }
                }
            }
            catch (e) {
                this.logger.warn('Graph API user lookup failed; caching as default userId to avoid re-querying.', { error: e });
                // Cache all failed lookups so we don't retry Graph API for these emails
                for (const email of needsGraph) {
                    if (!this.graphUserIdCache.has(email.toLowerCase())) {
                        this.graphUserIdCache.set(email.toLowerCase(), this.config.userId);
                    }
                }
            }
        }
        // 4. Ensure every email has at least the default
        for (const email of emails) {
            if (!resolved[email]) {
                resolved[email] = this.config.userId;
            }
        }
        this.logger.info(`Resolved ${emails.size} email(s): ${needsGraph.length} via Graph API, ${emails.size - needsGraph.length} from cache/users.json.`);
        return resolved;
    }
    getGlobPatterns() {
        const includePatterns = (this.config.filePatterns || []).map(p => p.trim()).filter(Boolean);
        const excludePatterns = (this.config.excludePatterns || []).map(p => p.trim()).filter(Boolean);
        // @actions/glob supports negated patterns by prefixing with '!'
        const negated = excludePatterns.map(p => (p.startsWith('!') ? p : `!${p}`));
        return [...includePatterns, ...negated];
    }
    normalizeRepoPath(path) {
        return path.replace(/\\/g, '/');
    }
    shouldIncludePath(path) {
        const normalized = this.normalizeRepoPath(path);
        const includePatterns = (this.config.filePatterns || []).map(p => p.trim()).filter(Boolean);
        const excludePatterns = (this.config.excludePatterns || []).map(p => p.trim()).filter(Boolean);
        const included = includePatterns.length === 0
            ? true
            : includePatterns.some(p => minimatch(normalized, p, { dot: true }));
        if (!included) {
            this.logger.info(`Excluding file '${path}' because it does not match any include patterns.`);
            return false;
        }
        const excluded = excludePatterns.some(p => minimatch(normalized, p, { dot: true }));
        if (excluded) {
            this.logger.info(`Excluding file '${path}' due to exclude pattern match.`);
        }
        return !excluded;
    }
    async getChangedFiles() {
        try {
            // For pull requests, get changed files
            if (github.context.eventName === 'pull_request') {
                return await this.getPullRequestFiles();
            }
            // For pushes, use glob patterns
            return await this.getFilesFromPatterns();
        }
        catch (error) {
            this.logger.error('Failed to get changed files', { error });
            throw error;
        }
    }
    async getAllRepoFiles() {
        const patterns = this.getGlobPatterns().join('\n');
        const globber = await glob.create(patterns);
        const files = await globber.glob();
        const maxBytes = this.config.maxFileSize;
        const result = [];
        for (const filePath of files) {
            try {
                const stats = fs.statSync(filePath);
                // Skip directories (glob should already do this, but keep it defensive)
                if (!stats.isFile()) {
                    continue;
                }
                if (stats.size === 0) {
                    continue;
                }
                if (stats.size > maxBytes) {
                    this.logger.warn(`Skipping oversized file during full scan: ${filePath} (${stats.size} bytes > ${maxBytes} bytes)`);
                    continue;
                }
                const isBinary = isBinaryPath(filePath);
                const encoding = isBinary ? 'base64' : 'utf-8';
                if (isBinary) {
                    this.logger.info(`Skipping binary file: ${filePath}`);
                    continue;
                }
                const buffer = fs.readFileSync(filePath);
                const content = buffer.toString('utf8');
                const sha = crypto.createHash('sha1').update(buffer).digest('hex');
                result.push({
                    path: filePath,
                    size: buffer.byteLength,
                    encoding,
                    sha,
                    content,
                    typeOfChange: 'unknown',
                    commitTimestamp: new Date().toISOString(),
                });
            }
            catch (e) {
                this.logger.warn(`Failed reading file during full scan: ${filePath}`, { error: e });
            }
        }
        this.logger.info(`Full scan selected ${result.length} files after filtering.`);
        // --- Resolve author info for each file ---
        const fileAuthorMap = this.getFileAuthorEmails(result);
        const uniqueEmails = new Set(Object.values(fileAuthorMap).filter(Boolean));
        const userIdMap = await this.resolveUserIds(uniqueEmails);
        // Assign resolved author info to each file
        for (const file of result) {
            const authorEmail = fileAuthorMap[file.path];
            if (authorEmail) {
                file.authorEmail = authorEmail;
                file.authorId = userIdMap[authorEmail.toLowerCase()] || this.config.userId;
            }
        }
        return result;
    }
    /**
     * Use `git log` to build a map of file path → last commit author email.
     * Runs a single git command for all files to stay efficient.
     */
    getFileAuthorEmails(files) {
        const workspace = process.env['GITHUB_WORKSPACE'] || process.cwd();
        const map = {};
        for (const file of files) {
            try {
                // git log -1 gives the most recent commit that touched the file
                const email = execSync(`git log -1 --format=%ae -- "${file.path}"`, { cwd: workspace, encoding: 'utf-8', timeout: 10000 }).trim();
                if (email) {
                    map[file.path] = email.toLowerCase();
                }
            }
            catch {
                // Silently skip files where git log fails (e.g. untracked files)
            }
        }
        this.logger.info(`Resolved author emails for ${Object.keys(map).length}/${files.length} files via git log.`);
        return map;
    }
    async getPrInfoForPush() {
        const commits = github.context.payload["commits"];
        const head_commit = github.context.payload["head_commit"];
        return {
            iterations: commits.length,
            authorEmail: head_commit.author?.email || head_commit?.committer?.email,
            authorLogin: head_commit?.author?.username || head_commit?.committer?.username,
            head: github.context.ref,
            base: github.context.ref,
            title: `Push to ${github.context.ref}`,
            url: github.context.payload["compare"],
        };
    }
    async getPrInfo() {
        if (github.context.eventName === "push") {
            this.logger.info('Processing push event, getting PR info for latest push');
            return this.getPrInfoForPush();
        }
        if (github.context.eventName === 'workflow_dispatch') {
            // Minimal PR-like metadata for manual runs.
            const branch = github.context.ref.replace('refs/heads/', '');
            return {
                iterations: 1,
                authorLogin: github.context.actor,
                authorEmail: undefined,
                head: branch,
                base: branch,
                title: `Manual run on ${branch}`,
                url: `${github.context.serverUrl}/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`,
            };
        }
        const pr = github.context.payload.pull_request;
        if (!pr) {
            throw new Error('Could not find pull request information');
        }
        const head = pr["head"].ref;
        const base = pr["base"].ref;
        const title = pr["title"];
        const url = pr["html_url"];
        const numCommits = pr["commits"];
        const userLogin = pr["user"].login;
        const { data: userData } = await this.octokit.rest.users.getByUsername({ username: userLogin });
        return {
            iterations: numCommits,
            authorLogin: userLogin,
            authorEmail: userData.email,
            head: head,
            base: base,
            title: title,
            url: url,
        };
    }
    async getFilesForCommit(commitSha, userId) {
        const { data: commit } = await this.octokit.rest.repos.getCommit({
            owner: this.config.repository.owner,
            repo: this.config.repository.repo,
            ref: commitSha
        });
        if (!commit.files || commit.files.length === 0) {
            this.logger.warn(`No files found in commit: ${commit.sha}`);
            return [];
        }
        this.logger.info(`Processing commit ${commit.sha} with ${commit.files.length} changed file(s).`);
        let fileMetadata = [];
        const token = await this.authService.getToken();
        this.purviewClient.setAuthToken(token.accessToken);
        const filteredCommitFiles = commit.files.filter((f) => this.shouldIncludePath(f.filename));
        this.logger.info(`Commit ${commit.sha}: ${filteredCommitFiles.length}/${commit.files.length} files match the configured patterns.`);
        for (const file of filteredCommitFiles) {
            if (isBinaryPath(file.filename)) {
                this.logger.info(`Skipping binary file: ${file.filename}`);
                continue;
            }
            const metadata = {
                path: file.filename,
                size: file.patch ? file.patch.length : 0,
                encoding: 'utf-8',
                sha: file.sha,
                content: file.patch || "",
                authorLogin: commit.author?.login || commit.committer?.login || null,
                authorEmail: commit.commit.author?.email || commit.commit.committer?.email || null,
                authorId: userId,
                numberOfDeletions: file.deletions,
                numberOfAdditions: file.additions,
                numberOfChanges: file.changes,
                typeOfChange: file.status,
                commitTimestamp: commit.commit.author?.date || commit.commit.committer?.date
            };
            fileMetadata.push(metadata);
        }
        return fileMetadata;
    }
    isCommitEmpty(commitSha) {
        if (commitSha && commitSha !== this.emptySha) {
            return false;
        }
        return true;
    }
    async getCommits() {
        const commits = github.context.payload["commits"];
        // Commits list should be populated for push events
        if (commits && commits.length > 0) {
            this.logger.info(`Found ${commits.length} commits in push event.`);
            const commitInfos = commits.map((commit) => ({
                sha: commit.id,
                email: commit.author?.email || commit.committer?.email || undefined,
            }));
            return commitInfos;
        }
        // For pull_request events, always list all PR commits
        if (github.context.payload.pull_request) {
            return this.getAllPRCommits();
        }
        let before = github.context.payload["before"];
        let after = github.context.payload["after"];
        if (!this.isCommitEmpty(before) && !this.isCommitEmpty(after)) {
            this.logger.info(`Comparing changes from commit ${before} to commit ${after}`);
            const { data: comparison } = await this.octokit.rest.repos.compareCommits({
                owner: this.config.repository.owner,
                repo: this.config.repository.repo,
                base: before,
                head: after
            });
            const commitInfos = comparison.commits.map((commit) => ({
                sha: commit.sha,
                email: commit.commit.author?.email || commit.commit.committer?.email || undefined
            }));
            return commitInfos;
        }
        this.logger.warn('No valid comparison found, returning empty commit list');
        return [];
    }
    async getAllPRCommits() {
        const pr = github.context.payload.pull_request;
        if (!pr) {
            this.logger.warn('No pull request context available for getAllPRCommits');
            return [];
        }
        this.logger.info(`Listing all commits in PR #${pr.number}`);
        const { data: commits } = await this.octokit.rest.pulls.listCommits({
            owner: this.config.repository.owner,
            repo: this.config.repository.repo,
            pull_number: pr.number
        });
        const commitInfos = commits.map((commit) => ({
            sha: commit.sha,
            email: commit.commit.author?.email || commit.commit.committer?.email || undefined
        }));
        this.logger.info(`Found ${commitInfos.length} total commit(s) in PR #${pr.number}`);
        return commitInfos;
    }
    async getFilesGroupedByCommit(lastProcessedHeadSha) {
        const allCommits = await this.getCommits();
        // Find commits to process by skipping everything up to and including lastProcessedHeadSha
        let commitsToProcess = allCommits;
        if (lastProcessedHeadSha) {
            const idx = allCommits.findIndex(c => c.sha === lastProcessedHeadSha);
            if (idx >= 0) {
                commitsToProcess = allCommits.slice(idx + 1);
                this.logger.info(`Found last processed head SHA ${lastProcessedHeadSha} at position ${idx}; skipping ${idx + 1} commit(s), ${commitsToProcess.length} remaining`);
            }
            else {
                this.logger.info(`Last processed head SHA ${lastProcessedHeadSha} not found in commit list; processing all ${allCommits.length} commit(s)`);
            }
        }
        if (commitsToProcess.length === 0) {
            this.logger.info('No new commits to process');
            return [];
        }
        // Resolve all author emails to user IDs up front
        const commitAuthorEmails = new Set();
        for (const commit of commitsToProcess) {
            if (commit.email) {
                commitAuthorEmails.add(commit.email.toLowerCase());
            }
        }
        const userIdMap = await this.resolveUserIds(commitAuthorEmails);
        const result = [];
        for (const commit of commitsToProcess) {
            this.logger.info(`Processing commit: ${commit.sha}`);
            let userId;
            if (commit.email) {
                userId = userIdMap[commit.email.toLowerCase()] || this.config.userId;
            }
            const files = await this.getFilesForCommit(commit.sha, userId);
            result.push({ sha: commit.sha, files });
        }
        return result;
    }
    async getLatestPushFiles(lastProcessedHeadSha) {
        const commitGroups = await this.getFilesGroupedByCommit(lastProcessedHeadSha);
        return commitGroups.flatMap(cg => cg.files);
    }
    async getPullRequestFiles() {
        const pr = github.context.payload.pull_request;
        if (!pr) {
            return this.getFilesFromPatterns();
        }
        const { data: files } = await this.octokit.rest.pulls.listFiles({
            owner: this.config.repository.owner,
            repo: this.config.repository.repo,
            pull_number: pr.number
        });
        const { data: commit } = await this.octokit.rest.repos.getCommit({
            owner: this.config.repository.owner,
            repo: this.config.repository.repo,
            ref: pr['head'].sha
        });
        this.logger.info(`Commit info: ${JSON.stringify(commit)}`);
        // Filter by patterns
        const matchedFiles = files
            .map((f) => f.filename)
            .filter((filename) => this.shouldIncludePath(filename));
        return matchedFiles;
    }
    async getFilesFromPatterns() {
        const patterns = this.getGlobPatterns().join('\n');
        const globber = await glob.create(patterns);
        const files = await globber.glob();
        return files;
    }
}
//# sourceMappingURL=fileProcessor.js.map