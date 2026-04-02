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
                // For full-scan files the last commit author doubles as committer
                // so that AiAgentInfo is populated in the payload.
                file.committerEmail = file.committerEmail || authorEmail;
                file.committerId = file.committerId || file.authorId;
            }
        }
        return result;
    }
    /**
     * Fetch recent commits for the default branch (used during full scans).
     * When `upToSha` is provided, only commits up to and including that SHA are
     * returned (i.e. commits *before* the current event). The current event's
     * commits are left for the diff path.
     */
    async getAllRepoCommits(upToSha) {
        const owner = this.config.repository.owner;
        const repo = this.config.repository.repo;
        this.logger.info(`Fetching recent commits for full scan${upToSha ? ` (up to ${upToSha})` : ''}`);
        const listParams = {
            owner,
            repo,
            per_page: 100,
        };
        // When a boundary SHA is provided, ask the GitHub API to start listing
        // from that SHA (inclusive), which excludes newer commits.
        if (upToSha) {
            listParams.sha = upToSha;
        }
        const { data: commits } = await this.octokit.rest.repos.listCommits(listParams);
        if (commits.length === 0) {
            this.logger.info('No commits found in repository');
            return [];
        }
        this.logger.info(`Found ${commits.length} commit(s) for full scan`);
        // Resolve author/committer emails to user IDs
        const allEmails = new Set();
        for (const c of commits) {
            const authorEmail = c.commit.author?.email;
            const committerEmail = c.commit.committer?.email;
            if (authorEmail)
                allEmails.add(authorEmail.toLowerCase());
            if (committerEmail)
                allEmails.add(committerEmail.toLowerCase());
        }
        const userIdMap = await this.resolveUserIds(allEmails);
        const result = [];
        for (const c of commits) {
            const authorEmail = c.commit.author?.email || undefined;
            const committerEmail = c.commit.committer?.email || undefined;
            const authorId = authorEmail ? (userIdMap[authorEmail.toLowerCase()] || this.config.userId) : undefined;
            const committerId = committerEmail ? (userIdMap[committerEmail.toLowerCase()] || this.config.userId) : undefined;
            result.push({
                sha: c.sha,
                files: [],
                message: c.commit.message || undefined,
                authorEmail,
                authorLogin: c.author?.login || undefined,
                authorName: c.commit.author?.name || undefined,
                authorId,
                committerEmail,
                committerLogin: c.committer?.login || undefined,
                committerName: c.commit.committer?.name || undefined,
                committerId,
                timestamp: c.commit.author?.date || c.commit.committer?.date || undefined,
            });
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
    async getFilesForCommit(commitSha, authorId, committerId) {
        const { data: commit } = await this.octokit.rest.repos.getCommit({
            owner: this.config.repository.owner,
            repo: this.config.repository.repo,
            ref: commitSha
        });
        const commitMeta = {
            sha: commit.sha,
            files: [],
            message: commit.commit.message || undefined,
            authorEmail: commit.commit.author?.email || undefined,
            authorLogin: commit.author?.login || undefined,
            authorName: commit.commit.author?.name || undefined,
            authorId,
            committerEmail: commit.commit.committer?.email || undefined,
            committerLogin: commit.committer?.login || undefined,
            committerName: commit.commit.committer?.name || undefined,
            committerId,
            timestamp: commit.commit.author?.date || commit.commit.committer?.date || undefined,
        };
        if (!commit.files || commit.files.length === 0) {
            this.logger.warn(`No files found in commit: ${commit.sha}`);
            return commitMeta;
        }
        this.logger.info(`Processing commit ${commit.sha} with ${commit.files.length} changed file(s).`);
        const filteredCommitFiles = commit.files.filter((f) => this.shouldIncludePath(f.filename));
        this.logger.info(`Commit ${commit.sha}: ${filteredCommitFiles.length}/${commit.files.length} files match the configured patterns.`);
        for (const file of filteredCommitFiles) {
            if (isBinaryPath(file.filename)) {
                this.logger.info(`Skipping binary file: ${file.filename}`);
                continue;
            }
            let fileContent = file.patch || "";
            let fileSize = file.patch ? file.patch.length : 0;
            // GitHub API omits .patch for large diffs — compute the diff ourselves
            if (!file.patch && file.status !== 'removed') {
                const diff = await this.computeDiff(file.filename, file.status || 'modified', commit.parents?.map((p) => p.sha) || [], commitSha);
                if (diff !== null) {
                    fileContent = diff;
                    fileSize = diff.length;
                }
            }
            const metadata = {
                path: file.filename,
                size: fileSize,
                encoding: 'utf-8',
                sha: file.sha,
                content: fileContent,
                authorLogin: commit.author?.login || commit.committer?.login || null,
                authorEmail: commit.commit.author?.email || commit.commit.committer?.email || null,
                authorId,
                committerLogin: commit.committer?.login || commit.author?.login || null,
                committerEmail: commit.commit.committer?.email || commit.commit.author?.email || null,
                committerId,
                numberOfDeletions: file.deletions,
                numberOfAdditions: file.additions,
                numberOfChanges: file.changes,
                typeOfChange: file.status,
                commitTimestamp: commit.commit.author?.date || commit.commit.committer?.date
            };
            commitMeta.files.push(metadata);
        }
        return commitMeta;
    }
    /**
     * Computes a unified diff for a file when the commit API omits the patch.
     * Fetches the file content at both the parent and current commits via the
     * GitHub Contents API, then produces a unified diff.
     */
    async computeDiff(filePath, status, parentShas, commitSha) {
        try {
            this.logger.info(`Patch missing for ${filePath} — computing diff (status: ${status})`);
            const currentContent = await this.fetchFileContent(filePath, commitSha);
            if (currentContent === null) {
                return null;
            }
            let parentContent = null;
            if (status !== 'added' && parentShas.length > 0) {
                parentContent = await this.fetchFileContent(filePath, parentShas[0]);
            }
            const oldLines = parentContent ? parentContent.split('\n') : [];
            const newLines = currentContent.split('\n');
            return this.generateUnifiedDiff(filePath, oldLines, newLines);
        }
        catch (error) {
            this.logger.warn(`Failed to compute diff for ${filePath}`, { error });
            return null;
        }
    }
    /**
     * Fetches file content from the GitHub API at a specific ref.
     * Uses the Contents API for small files (≤1MB base64) and falls back to
     * the raw download URL for larger files.
     */
    async fetchFileContent(filePath, ref) {
        try {
            const { data } = await this.octokit.rest.repos.getContent({
                owner: this.config.repository.owner,
                repo: this.config.repository.repo,
                path: filePath,
                ref,
            });
            if (Array.isArray(data)) {
                this.logger.warn(`${filePath} is a directory at ${ref}`);
                return null;
            }
            // For files ≤1MB the API returns base64 content inline
            if ('content' in data && data.content) {
                return Buffer.from(data.content, 'base64').toString('utf-8');
            }
            // For larger files, download via the raw URL
            if ('download_url' in data && data.download_url) {
                this.logger.info(`File ${filePath} too large for Contents API — downloading raw content`);
                const response = await fetch(data.download_url);
                if (!response.ok) {
                    this.logger.warn(`Raw download failed for ${filePath}: ${response.status}`);
                    return null;
                }
                return await response.text();
            }
            this.logger.warn(`${filePath} has no content or download URL at ${ref}`);
            return null;
        }
        catch (error) {
            this.logger.warn(`Failed to fetch content for ${filePath} at ${ref}`, { error });
            return null;
        }
    }
    /**
     * Produces a unified diff string from two arrays of lines.
     * Uses a simple LCS-based approach to generate hunks matching standard
     * unified diff format (the same format GitHub returns in .patch).
     */
    generateUnifiedDiff(filePath, oldLines, newLines) {
        const hunks = this.computeHunks(oldLines, newLines);
        if (hunks.length === 0) {
            return '';
        }
        const parts = [];
        parts.push(`--- a/${filePath}`);
        parts.push(`+++ b/${filePath}`);
        for (const hunk of hunks) {
            parts.push(hunk);
        }
        return parts.join('\n');
    }
    /**
     * Computes unified-diff hunks from old and new line arrays.
     * Groups consecutive changes with up to 3 lines of context around each change.
     */
    computeHunks(oldLines, newLines) {
        const CONTEXT = 3;
        // Build an edit script using a simple O(NM) LCS approach
        const edits = this.buildEditScript(oldLines, newLines);
        // Group edits into hunks with context lines
        const hunks = [];
        let i = 0;
        while (i < edits.length) {
            // Skip unchanged lines until we find a change
            if (edits[i].type === 'equal') {
                i++;
                continue;
            }
            // Found a change — start a new hunk with leading context
            const contextStart = Math.max(0, i - CONTEXT);
            let hunkEnd = i;
            // Extend hunk to include all nearby changes (within CONTEXT*2 lines of each other)
            while (hunkEnd < edits.length) {
                if (edits[hunkEnd].type !== 'equal') {
                    hunkEnd++;
                    continue;
                }
                // Look ahead to see if there's another change within context range
                let nextChange = hunkEnd;
                while (nextChange < edits.length && edits[nextChange].type === 'equal') {
                    nextChange++;
                }
                if (nextChange < edits.length && nextChange - hunkEnd <= CONTEXT * 2) {
                    hunkEnd = nextChange + 1;
                }
                else {
                    break;
                }
            }
            // Add trailing context
            const contextEnd = Math.min(edits.length, hunkEnd + CONTEXT);
            // Calculate line numbers for the hunk header
            let oldStart = 1, oldCount = 0, newStart = 1, newCount = 0;
            // Count lines before this hunk
            for (let j = 0; j < contextStart; j++) {
                if (edits[j].type !== 'insert')
                    oldStart++;
                if (edits[j].type !== 'delete')
                    newStart++;
            }
            const hunkLines = [];
            for (let j = contextStart; j < contextEnd; j++) {
                const edit = edits[j];
                if (edit.type === 'equal') {
                    hunkLines.push(` ${edit.line}`);
                    oldCount++;
                    newCount++;
                }
                else if (edit.type === 'delete') {
                    hunkLines.push(`-${edit.line}`);
                    oldCount++;
                }
                else {
                    hunkLines.push(`+${edit.line}`);
                    newCount++;
                }
            }
            hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${hunkLines.join('\n')}`);
            i = contextEnd;
        }
        return hunks;
    }
    /**
     * Builds an edit script (sequence of equal/delete/insert operations)
     * from two arrays of lines using LCS-based diff.
     * For files exceeding a line count threshold, falls back to a simple
     * delete-all/insert-all to avoid excessive memory usage.
     */
    buildEditScript(oldLines, newLines) {
        const MAX_LINES_FOR_LCS = 10_000;
        const m = oldLines.length;
        const n = newLines.length;
        // For very large files, the O(m*n) DP table would use too much memory.
        // Fall back to a simple delete-old/insert-new diff.
        if (m > MAX_LINES_FOR_LCS || n > MAX_LINES_FOR_LCS) {
            const edits = [];
            for (const line of oldLines) {
                edits.push({ type: 'delete', line });
            }
            for (const line of newLines) {
                edits.push({ type: 'insert', line });
            }
            return edits;
        }
        // Build the full LCS DP table for backtracking
        const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (oldLines[i - 1] === newLines[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                }
                else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }
        // Backtrack to produce the edit script
        const edits = [];
        let oi = m, ni = n;
        while (oi > 0 || ni > 0) {
            if (oi > 0 && ni > 0 && oldLines[oi - 1] === newLines[ni - 1]) {
                edits.push({ type: 'equal', line: oldLines[oi - 1] });
                oi--;
                ni--;
            }
            else if (ni > 0 && (oi === 0 || dp[oi][ni - 1] >= dp[oi - 1][ni])) {
                edits.push({ type: 'insert', line: newLines[ni - 1] });
                ni--;
            }
            else {
                edits.push({ type: 'delete', line: oldLines[oi - 1] });
                oi--;
            }
        }
        edits.reverse();
        return edits;
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
                committerEmail: commit.committer?.email || undefined,
                message: commit.message || undefined,
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
                email: commit.commit.author?.email || commit.commit.committer?.email || undefined,
                committerEmail: commit.commit.committer?.email || undefined,
                message: commit.commit.message || undefined,
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
            email: commit.commit.author?.email || commit.commit.committer?.email || undefined,
            committerEmail: commit.commit.committer?.email || undefined,
            message: commit.commit.message || undefined,
        }));
        this.logger.info(`Found ${commitInfos.length} total commit(s) in PR #${pr.number}`);
        return commitInfos;
    }
    async getFilesGroupedByCommit(lastProcessedHeadSha, prefetchedCommits) {
        const allCommits = prefetchedCommits ?? await this.getCommits();
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
        // Resolve all author and committer emails to user IDs up front
        const allEmails = new Set();
        for (const commit of commitsToProcess) {
            if (commit.email) {
                allEmails.add(commit.email.toLowerCase());
            }
            if (commit.committerEmail) {
                allEmails.add(commit.committerEmail.toLowerCase());
            }
        }
        const userIdMap = await this.resolveUserIds(allEmails);
        const result = [];
        for (const commit of commitsToProcess) {
            this.logger.info(`Processing commit: ${commit.sha}`);
            let userId;
            if (commit.email) {
                userId = userIdMap[commit.email.toLowerCase()] || this.config.userId;
            }
            let committerId;
            if (commit.committerEmail) {
                committerId = userIdMap[commit.committerEmail.toLowerCase()] || this.config.userId;
            }
            const commitFiles = await this.getFilesForCommit(commit.sha, userId, committerId);
            result.push(commitFiles);
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