describe('workflowRepo', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function loadModule() {
    // Re-import to pick up env changes
    return require('../../src/utils/workflowRepo') as typeof import('../../src/utils/workflowRepo');
  }

  it('returns undefined when GITHUB_WORKFLOW_REF is not set', () => {
    delete process.env['GITHUB_WORKFLOW_REF'];
    const { tryParseWorkflowRepoFromEnv } = loadModule();
    expect(tryParseWorkflowRepoFromEnv()).toBeUndefined();
  });

  it('returns undefined when GITHUB_WORKFLOW_REF is empty', () => {
    process.env['GITHUB_WORKFLOW_REF'] = '';
    const { tryParseWorkflowRepoFromEnv } = loadModule();
    expect(tryParseWorkflowRepoFromEnv()).toBeUndefined();
  });

  it('returns undefined when GITHUB_WORKFLOW_REF is whitespace-only', () => {
    process.env['GITHUB_WORKFLOW_REF'] = '   ';
    const { tryParseWorkflowRepoFromEnv } = loadModule();
    expect(tryParseWorkflowRepoFromEnv()).toBeUndefined();
  });

  it('returns undefined when path has fewer than 2 segments', () => {
    process.env['GITHUB_WORKFLOW_REF'] = 'onlyone@refs/heads/main';
    const { tryParseWorkflowRepoFromEnv } = loadModule();
    expect(tryParseWorkflowRepoFromEnv()).toBeUndefined();
  });

  it('parses standard workflow ref with branch ref', () => {
    process.env['GITHUB_WORKFLOW_REF'] =
      'Org/WorkflowRepo/.github/workflows/workflow.yml@refs/heads/main';
    const { tryParseWorkflowRepoFromEnv } = loadModule();
    const result = tryParseWorkflowRepoFromEnv();
    expect(result).toEqual({
      owner: 'Org',
      repo: 'WorkflowRepo',
      ref: 'refs/heads/main',
    });
  });

  it('parses workflow ref with tag ref', () => {
    process.env['GITHUB_WORKFLOW_REF'] =
      'myorg/myrepo/.github/workflows/ci.yml@v1';
    const { tryParseWorkflowRepoFromEnv } = loadModule();
    const result = tryParseWorkflowRepoFromEnv();
    expect(result).toEqual({
      owner: 'myorg',
      repo: 'myrepo',
      ref: 'v1',
    });
  });

  it('handles workflow ref without @ sign (no ref)', () => {
    process.env['GITHUB_WORKFLOW_REF'] =
      'owner/repo/.github/workflows/deploy.yml';
    const { tryParseWorkflowRepoFromEnv } = loadModule();
    const result = tryParseWorkflowRepoFromEnv();
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      ref: undefined,
    });
  });

  it('handles minimal owner/repo format', () => {
    process.env['GITHUB_WORKFLOW_REF'] = 'owner/repo@refs/heads/main';
    const { tryParseWorkflowRepoFromEnv } = loadModule();
    const result = tryParseWorkflowRepoFromEnv();
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      ref: 'refs/heads/main',
    });
  });
});
