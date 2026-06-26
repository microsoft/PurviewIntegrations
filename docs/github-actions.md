# GitHub Actions Conventions

This repository ships a **JavaScript/TypeScript GitHub Action** (`runs.using: node20`,
`runs.main: dist/index.js` in [`action.yml`](../action.yml)). The rules below are the
Actions-specific best practices that apply on top of the general
[code conventions](conventions.md). They describe what the repo already does and what new
code must keep doing.

## `action.yml` metadata

- Declare every input and output in [`action.yml`](../action.yml). Inputs and outputs use
  **kebab-case** names (`client-id`, `users-json-path`, `processed-files`).
- Give each input a clear `description`, mark it `required: true` only when the action cannot
  run without it, and provide a `default` for optional inputs where a sensible one exists
  (e.g. `file-patterns: '**'`, `max-file-size: '10485760'`).
- Keep `runs.using` (`node20`) in sync with the Node version used in CI and in
  [`tsconfig.json`](../tsconfig.json) target expectations. Bump them together.
- `runs.main` points at the committed bundle `dist/index.js` — never at `src/`.

## Inputs and outputs (the `@actions/core` toolkit)

- Read inputs through `@actions/core`, never `process.env` or raw `argv`:
  - strings: `core.getInput('name', { required: true })`
  - booleans: `core.getBooleanInput('name')`
- Validate and normalize all inputs in one place — [`src/validation/inputValidator.ts`](../src/validation/inputValidator.ts) —
  before any work begins, so failures surface early with actionable messages.
- Set outputs declared in `action.yml` via `core.setOutput('processed-files', n)` (see
  [`src/runner/gitHubActionsRunner.ts`](../src/runner/gitHubActionsRunner.ts)). Every output
  the action documents must actually be set on the success path.
- Any new input or output must be added in **three** places that stay consistent:
  `action.yml`, the validator/runner that reads or writes it, and the README/`Instructions.md`
  usage docs.

## Error handling

- The action **never throws to the runner** and **never calls `process.exit`**. The top-level
  `run()` wraps work in `try/catch` and reports failure with `core.setFailed(message)`
  ([`src/index.ts`](../src/index.ts), [`src/runner/gitHubActionsRunner.ts`](../src/runner/gitHubActionsRunner.ts)).
  `core.setFailed` sets a non-zero exit code *and* an annotated failure — preserve this.
- Use `core.warning` / `core.error` for non-fatal and fatal annotations, and
  `core.info` / `core.debug` for normal and verbose logging. Do not use bare `console.log`.
- Group noisy phases with `core.startGroup` / `core.endGroup`.

## Secrets and logging

- **Never log tokens, secrets, certificates, or full request payloads.** Route logging through
  [`src/utils/logger.ts`](../src/utils/logger.ts), whose `sanitizeData` redaction strips
  sensitive fields from messages and errors.
- When a secret value is *derived* at runtime (e.g. an access token minted from OIDC), register
  it with `core.setSecret(value)` so the runner masks it in logs as well.
- Debug logging is gated on the `debug` input **or** `RUNNER_DEBUG=1`
  (`core.getBooleanInput('debug') || process.env['RUNNER_DEBUG'] === '1'`). Keep secrets out of
  debug output too.

## The `dist/` bundle invariant

The runner executes the committed bundle, not the TypeScript source, so `dist/` **must always
match `src/`**:

- Regenerate with `npm run build && npm run package` (tsc → `ncc`). Never hand-edit `dist/`.
- The [`.husky/pre-commit`](../.husky/pre-commit) hook rebuilds and re-stages `dist/`, but that
  is local and bypassable.
- CI enforces the invariant with [`.github/workflows/check-dist.yml`](../.github/workflows/check-dist.yml):
  it rebuilds the bundle and fails if the committed `dist/` differs. If that job fails, run
  `npm run build && npm run package` and commit the result.

## Workflow security & supply chain

These apply to the workflows under [`.github/workflows/`](../.github/workflows):

- **Pin third-party actions to a full commit SHA**, with the human-readable version in a
  trailing comment, e.g. `uses: actions/checkout@<sha> # v4.3.1`. Tags (`@v4`) are mutable and
  are not used here.
- Grant **least-privilege `permissions`**. Default to `permissions: contents: read` and add
  scopes only where a job needs them (e.g. `id-token: write` for OIDC, `pull-requests: write`
  for PR comments). Consumers of this action enable `id-token: write` for OIDC auth — see the
  README usage example.
- Use `npm ci` (not `npm install`) in CI for reproducible installs from the lockfile.

## Versioning & releases

- This action is consumed by Git ref (the README usage pins `@v1`). Releases follow
  **semantic versioning**, and the moving **major tag** (`v1`) is advanced to the latest
  compatible release so consumers tracking `@v1` pick up fixes.
- A release must include an up-to-date `dist/` bundle (the same invariant CI checks on every
  PR).

## Related

- General code/test conventions: [`conventions.md`](conventions.md)
- Testing patterns (mocking `@actions/*`): [`testing-patterns.md`](testing-patterns.md)
- Agent router: [`../AGENTS.md`](../AGENTS.md)
