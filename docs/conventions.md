# Code Conventions

Observed conventions for the **Purview GitHub Action** codebase. New code (human- or
agent-authored) should match these patterns. This document records what the repo already
does; it is descriptive, not aspirational.

## Language & compiler

- **TypeScript**, compiled with `tsc` (see [`tsconfig.json`](../tsconfig.json)).
- Targets and modules: `ES2022` target, `ES2022` module, `node` module resolution.
- **Strict mode is on and tightened.** The following are enabled and must be honored:
  `strict`, `noImplicitAny`, `strictNullChecks`, `noUnusedLocals`, `noUnusedParameters`,
  `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `allowUnreachableCode: false`.
  Do not introduce code that violates these; do not loosen the compiler options to make code
  compile.
- `forceConsistentCasingInFileNames` is on — import paths must match file casing exactly.
- Declaration maps and source maps are emitted; `dist/` is generated, never hand-edited.

## Project structure

Source lives under [`src/`](../src/), organized by responsibility:

| Folder | Responsibility |
| --- | --- |
| `src/api/` | Purview API client |
| `src/auth/` | Authentication + token providers (OIDC / certificate / client-secret) |
| `src/config/` | Shared types |
| `src/file/` | File discovery and processing |
| `src/payload/` | Payload construction and chunking |
| `src/runner/` | GitHub Actions runner entry + full-scan service |
| `src/state/` | State persistence service |
| `src/utils/` | Cross-cutting helpers (logger, retry, redaction, PR comments, user resolution) |
| `src/validation/` | Input validation |

`src/index.ts` is the action entry point. The single bundled artifact is produced by `ncc`
into `dist/index.js` and committed.

## Tests

- Framework: **Jest** with **ts-jest** (see [`jest.config.js`](../jest.config.js)).
- Tests live under [`tests/`](../tests/), mirroring the `src/` layout, named
  `*.test.ts` (`testMatch: ['**/tests/**/*.test.ts']`).
- ESM-only `@actions/*` packages are mapped to their lib entry points in `jest.config.js`;
  each test file provides its own mock factory for those modules. Follow the same pattern
  when testing code that imports `@actions/core`, `@actions/github`, `@actions/glob`, or
  `@actions/exec`.
- Add or update a sibling `tests/<area>/<name>.test.ts` for any behavior change.

## Build, package, lint

Defined in [`package.json`](../package.json) scripts:

| Script | Command | Purpose |
| --- | --- | --- |
| `npm run build` | `tsc` | Type-check and compile |
| `npm run package` | `ncc build dist/index.js -o dist` | Bundle the action into `dist/` |
| `npm run test` | `jest --passWithNoTests` | Run all tests |
| `npm run lint` | `eslint src/**/*.ts` | Lint sources |
| `npm run format` | `prettier --write src/**/*.ts` | Format sources |
| `npm run all` | build + package + test | Full local validation |

A [`.husky/pre-commit`](../.husky/pre-commit) hook runs `npm test`, rebuilds, and re-stages
the bundled `dist/` files (`dist/index.js`, `dist/sourcemap-register.js`,
`dist/licenses.txt`) on every commit — so `dist/` stays in sync with source. CI
([`.github/workflows/tests.yml`](../.github/workflows/tests.yml)) runs `npm ci && npm test`
on push to `main` and on every pull request.

## Security & logging conventions

These patterns are already established in the codebase and should be preserved:

- Authentication tokens are never logged; sensitive data is redacted from error messages
  (see `src/utils/logger.ts`).
- API calls use retry with exponential backoff (`src/utils/retryHandler.ts`) and respect
  rate limiting.
- Inputs are validated (`src/validation/inputValidator.ts`) before processing.
- Binary files are detected and skipped during scanning.

## Related context

- Product overview & usage: [`README.md`](../README.md)
- End-to-end setup: [`Instructions.md`](../Instructions.md)
- PR / work-item tagging: [`.github/instructions/telemetry.instructions.md`](../.github/instructions/telemetry.instructions.md)
- Agent router: [`AGENTS.md`](../AGENTS.md)
