import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('@actions/core', () => ({
  setFailed: jest.fn(),
}));

jest.mock('../src/validation/inputValidator', () => ({
  validateInputs: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/runner/gitHubActionsRunner', () => ({
  GitHubActionsRunner: jest.fn().mockImplementation(() => ({
    execute: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../src/utils/logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  })),
}));

describe('action runtime security', () => {
  const originalNodeVersion = Object.getOwnPropertyDescriptor(process.versions, 'node')!;

  it('declares the supported Node 24 action runtime', () => {
    const metadata = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
    expect(metadata).toMatch(/^\s+using: 'node24'\s*$/m);
  });

  afterEach(() => {
    Object.defineProperty(process.versions, 'node', originalNodeVersion);
    jest.resetModules();
  });

  it.each([
    ['20.20.2', false],
    ['22.23.4', false],
    ['24.0.0', false],
    ['24.21.9', false],
    ['24.22.0', false],
    ['24.22.1-rc.0', false],
    ['24.22.1', true],
    ['24.22.2', true],
    ['24.23.0', true],
    ['26.12.1', false],
  ])('checks Node %s before input validation or execution', async (version, allowed) => {
    Object.defineProperty(process.versions, 'node', { value: version, configurable: true });

    await jest.isolateModulesAsync(async () => {
      const core = await import('@actions/core');
      const { validateInputs } = await import('../src/validation/inputValidator');
      const { GitHubActionsRunner } = await import('../src/runner/gitHubActionsRunner');
      await import('../src/index');

      if (allowed) {
        expect(core.setFailed).not.toHaveBeenCalled();
        expect(validateInputs).toHaveBeenCalledTimes(1);
        expect(GitHubActionsRunner).toHaveBeenCalledTimes(1);
      } else {
        expect(core.setFailed).toHaveBeenCalledWith(
          expect.stringContaining('Node.js 24.22.1 or later in the 24.x line is required')
        );
        expect(validateInputs).not.toHaveBeenCalled();
        expect(GitHubActionsRunner).not.toHaveBeenCalled();
      }
    });
  });
});
