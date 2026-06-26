# Testing Patterns

How tests are written in this repository. Follow these patterns when adding or changing
tests so they stay consistent and runnable. This is descriptive of the existing suite under
[`tests/`](../tests/).

## Framework & layout

- **Jest** with **ts-jest** ([`jest.config.js`](../jest.config.js)). No separate compile step
  is needed — `ts-jest` transpiles on the fly.
- Tests live under [`tests/`](../tests/), mirroring the `src/` folder layout, and are named
  `*.test.ts` (`testMatch: ['**/tests/**/*.test.ts']`).
- Add or update a sibling `tests/<area>/<name>.test.ts` for every behavior change.
- Run with `npm run test` (or `pwsh scripts/verify.ps1` for the full install→build→test loop).

## Mocking the `@actions/*` toolkit

The `@actions/*` packages are **ESM-only**, so Jest's CommonJS resolver cannot load them
directly. Two things make them testable, and both must be kept in sync:

1. **`moduleNameMapper` in [`jest.config.js`](../jest.config.js)** points each `@actions/*`
   import at its compiled `lib` entry so Jest can resolve the module:

   ```js
   moduleNameMapper: {
     '^@actions/core$': '<rootDir>/node_modules/@actions/core/lib/core.js',
     '^@actions/github$': '<rootDir>/node_modules/@actions/github/lib/github.js',
     '^@actions/glob$': '<rootDir>/node_modules/@actions/glob/lib/glob.js',
     '^@actions/exec$': '<rootDir>/node_modules/@actions/exec/lib/exec.js',
   },
   ```

2. **A `jest.mock()` factory at the top of each test file**, *before* the imports under test,
   replaces the toolkit with controllable mocks:

   ```ts
   jest.mock('@actions/core', () => ({
     getBooleanInput: jest.fn().mockReturnValue(false),
     debug: jest.fn(),
     info: jest.fn(),
     warning: jest.fn(),
     error: jest.fn(),
     startGroup: jest.fn(),
     endGroup: jest.fn(),
   }));

   import { PurviewClient } from '../../src/api/purviewClient';
   ```

   `jest.mock` calls are hoisted above imports, so the factory is in place before the module
   under test pulls in `@actions/core`. Only stub the toolkit functions the code under test
   actually calls. When mapping a **new** `@actions/*` package, add it to *both* the
   `moduleNameMapper` and the per-file `jest.mock` factory.

## Test data & isolation

- Build config objects with a small `createConfig(overrides)` helper so each test states only
  what it cares about (see [`tests/api/purviewClient.test.ts`](../tests/api/purviewClient.test.ts)).
- Use deterministic fixture values (fixed GUIDs, repo metadata, SHAs) — never real
  credentials or live endpoints.
- Stub network and time: save and restore `globalThis.fetch` around tests that exercise the
  Purview client, and prefer Jest fake timers over real delays when testing retry/backoff.
- Reset mocks between tests (`beforeEach`) so call assertions don't leak across cases.

## What to test

- Input validation and normalization ([`src/validation/`](../src/validation/)).
- Error paths surface through `core.setFailed` / `core.warning`, not thrown exceptions.
- Retry/backoff behavior and rate-limit handling ([`src/utils/retryHandler.ts`](../src/utils/retryHandler.ts)).
- Payload construction/chunking and file filtering (binary-file skipping, exclude patterns).

## Related

- Code conventions: [`conventions.md`](conventions.md)
- GitHub Actions conventions: [`github-actions.md`](github-actions.md)
