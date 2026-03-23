jest.mock('@actions/core', () => ({
  getBooleanInput: jest.fn().mockReturnValue(false),
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
}));

jest.mock('@actions/github', () => ({
  getOctokit: jest.fn(() => ({})),
  context: {
    eventName: 'pull_request',
    payload: {},
    repo: { owner: 'test', repo: 'test' },
    ref: 'refs/heads/main',
    sha: 'abc123',
  },
}));

jest.mock('@actions/glob', () => ({ create: jest.fn() }));
jest.mock('is-binary-path', () => ({ default: jest.fn(() => false) }));
jest.mock('../../src/api/purviewClient', () => ({ PurviewClient: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../src/auth/authenticationService', () => ({ AuthenticationService: jest.fn().mockImplementation(() => ({})) }));

import { FileProcessor } from '../../src/file/fileProcessor';
import { ActionConfig } from '../../src/config/types';

function createConfig(): ActionConfig {
  return {
    clientId: '11111111-1111-1111-1111-111111111111',
    tenantId: '22222222-2222-2222-2222-222222222222',
    purviewAccountName: 'test-account',
    purviewEndpoint: 'https://graph.microsoft.com/v1.0',
    filePatterns: ['**'],
    maxFileSize: 10485760,
    debug: false,
    userId: 'default-user-id',
    repository: {
      owner: 'testOwner',
      repo: 'testRepo',
      branch: 'main',
      sha: 'abc123',
      runId: '999',
      runNumber: '1',
    },
  };
}

describe('FileProcessor — diff computation', () => {
  let processor: FileProcessor;

  beforeEach(() => {
    processor = new FileProcessor(createConfig());
  });

  const buildEditScript = (oldLines: string[], newLines: string[]) =>
    (processor as any).buildEditScript(oldLines, newLines);

  const generateUnifiedDiff = (filePath: string, oldLines: string[], newLines: string[]) =>
    (processor as any).generateUnifiedDiff(filePath, oldLines, newLines);

  const computeHunks = (oldLines: string[], newLines: string[]) =>
    (processor as any).computeHunks(oldLines, newLines);

  describe('buildEditScript', () => {
    it('returns empty for two empty arrays', () => {
      const edits = buildEditScript([], []);
      expect(edits).toEqual([]);
    });

    it('marks all lines as inserts for new file', () => {
      const edits = buildEditScript([], ['line1', 'line2']);
      expect(edits).toEqual([
        { type: 'insert', line: 'line1' },
        { type: 'insert', line: 'line2' },
      ]);
    });

    it('marks all lines as deletes when file is emptied', () => {
      const edits = buildEditScript(['line1', 'line2'], []);
      expect(edits).toEqual([
        { type: 'delete', line: 'line1' },
        { type: 'delete', line: 'line2' },
      ]);
    });

    it('marks identical files as all equal', () => {
      const lines = ['a', 'b', 'c'];
      const edits = buildEditScript(lines, lines);
      expect(edits.every((e: any) => e.type === 'equal')).toBe(true);
      expect(edits).toHaveLength(3);
    });

    it('detects a single line change in the middle', () => {
      const old = ['a', 'b', 'c'];
      const new_ = ['a', 'x', 'c'];
      const edits = buildEditScript(old, new_);

      expect(edits[0]).toEqual({ type: 'equal', line: 'a' });
      // 'b' deleted, 'x' inserted (or vice versa depending on LCS tie-breaking)
      const mid = edits.slice(1, -1);
      expect(mid.some((e: any) => e.type === 'delete' && e.line === 'b')).toBe(true);
      expect(mid.some((e: any) => e.type === 'insert' && e.line === 'x')).toBe(true);
      expect(edits[edits.length - 1]).toEqual({ type: 'equal', line: 'c' });
    });

    it('detects an addition at the end', () => {
      const old = ['a', 'b'];
      const new_ = ['a', 'b', 'c'];
      const edits = buildEditScript(old, new_);

      expect(edits).toEqual([
        { type: 'equal', line: 'a' },
        { type: 'equal', line: 'b' },
        { type: 'insert', line: 'c' },
      ]);
    });

    it('detects a deletion at the start', () => {
      const old = ['a', 'b', 'c'];
      const new_ = ['b', 'c'];
      const edits = buildEditScript(old, new_);

      expect(edits).toEqual([
        { type: 'delete', line: 'a' },
        { type: 'equal', line: 'b' },
        { type: 'equal', line: 'c' },
      ]);
    });

    it('falls back to delete-all/insert-all for very large files', () => {
      const large = Array.from({ length: 10_001 }, (_, i) => `line${i}`);
      const edits = buildEditScript(large, large);

      // Should NOT use LCS (too large), so all deletes then all inserts
      const deletes = edits.filter((e: any) => e.type === 'delete');
      const inserts = edits.filter((e: any) => e.type === 'insert');
      expect(deletes).toHaveLength(10_001);
      expect(inserts).toHaveLength(10_001);
    });
  });

  describe('generateUnifiedDiff', () => {
    it('returns empty string for identical files', () => {
      const lines = ['a', 'b', 'c'];
      const diff = generateUnifiedDiff('test.ts', lines, lines);
      expect(diff).toBe('');
    });

    it('produces diff header with file path', () => {
      const diff = generateUnifiedDiff('src/app.ts', ['old'], ['new']);
      expect(diff).toContain('--- a/src/app.ts');
      expect(diff).toContain('+++ b/src/app.ts');
    });

    it('shows additions with + prefix', () => {
      const diff = generateUnifiedDiff('f.ts', [], ['added line']);
      expect(diff).toContain('+added line');
    });

    it('shows deletions with - prefix', () => {
      const diff = generateUnifiedDiff('f.ts', ['removed line'], []);
      expect(diff).toContain('-removed line');
    });

    it('shows context lines with space prefix', () => {
      const old = ['ctx1', 'old', 'ctx2'];
      const new_ = ['ctx1', 'new', 'ctx2'];
      const diff = generateUnifiedDiff('f.ts', old, new_);
      expect(diff).toContain(' ctx1');
      expect(diff).toContain(' ctx2');
    });

    it('includes @@ hunk header', () => {
      const diff = generateUnifiedDiff('f.ts', ['a'], ['b']);
      expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    });
  });

  describe('computeHunks', () => {
    it('returns no hunks for identical content', () => {
      const hunks = computeHunks(['a', 'b'], ['a', 'b']);
      expect(hunks).toHaveLength(0);
    });

    it('returns a single hunk for a small change', () => {
      const hunks = computeHunks(['a', 'b', 'c'], ['a', 'x', 'c']);
      expect(hunks).toHaveLength(1);
      expect(hunks[0]).toContain('@@');
    });

    it('groups nearby changes into one hunk', () => {
      // Changes at lines 2 and 4 — within context range, should be one hunk
      const old = ['a', 'b', 'c', 'd', 'e'];
      const new_ = ['a', 'B', 'c', 'D', 'e'];
      const hunks = computeHunks(old, new_);
      expect(hunks).toHaveLength(1);
    });

    it('produces separate hunks for distant changes', () => {
      // Two changes separated by more than 6 lines of context
      const old = Array.from({ length: 20 }, (_, i) => `line${i}`);
      const new_ = [...old];
      new_[1] = 'changed1';
      new_[18] = 'changed18';
      const hunks = computeHunks(old, new_);
      expect(hunks.length).toBeGreaterThanOrEqual(2);
    });
  });
});
