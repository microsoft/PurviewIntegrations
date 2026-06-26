# GitHub Copilot / AI Agent Instructions

These instructions apply to any AI agent (Copilot CLI, Copilot Chat, Claude, Cursor, etc.)
contributing to this repository. Start from [`AGENTS.md`](../AGENTS.md) for the full router
of context, conventions, and the build/test loop.

## Quick orientation

- This is a **TypeScript GitHub Action** (`src/index.ts` → bundled to `dist/` via `ncc`).
- Code style, structure, and test patterns: [`docs/conventions.md`](../docs/conventions.md).
- GitHub Actions conventions (action.yml, inputs/outputs, secrets, workflow security):
  [`docs/github-actions.md`](../docs/github-actions.md).
- Test framework and `@actions/*` mocking pattern: [`docs/testing-patterns.md`](../docs/testing-patterns.md).
- Build/test loop: `npm run build`, `npm run package`, `npm run test`, `npm run lint`
  (documented in the README **Development** section).
- A `.husky/pre-commit` hook runs tests, rebuilds, and re-stages `dist/` on every commit —
  never hand-edit `dist/`; regenerate it with `npm run build && npm run package`.

## GitHub Actions guardrails

Because the runner executes the committed `dist/index.js` bundle (not the source), these
rules are mandatory. Full detail in [`docs/github-actions.md`](../docs/github-actions.md):

- **Fail via `core.setFailed(message)`** — never `throw` to the runner and never
  `process.exit`. Use `core.warning` / `core.error` / `core.info` / `core.debug` instead of
  `console.log`.
- **Never log secrets.** Route logging through `src/utils/logger.ts` (it redacts sensitive
  fields); call `core.setSecret(value)` for any secret derived at runtime.
- **Read inputs via `@actions/core`** (`getInput` / `getBooleanInput`) and validate them in
  `src/validation/inputValidator.ts`. Set declared outputs via `core.setOutput`.
- **Keep `action.yml`, the reader/writer code, and the docs in sync** when adding an input or
  output. Inputs/outputs use kebab-case.
- **Keep `dist/` in sync with `src/`** — `npm run build && npm run package`. CI's `check-dist`
  job fails the PR if they diverge.
- **In workflows:** pin third-party actions to a full commit SHA (with a `# vX.Y.Z` comment),
  set least-privilege `permissions`, and use `npm ci`.

## PR-size guardrails

- Keep pull requests **reasonably sized and focused** on a single logical change. Prefer
  several small, reviewable PRs over one large mixed PR.
- If a task naturally grows large, **split it** into independent PRs (e.g., refactor first,
  then behavior change) and note the sequencing.
- Avoid mixing unrelated concerns (a feature + a broad reformat) in one PR.
- Regenerated `dist/` bundle changes are expected alongside source changes — that is not a
  reason to split, but do not bundle unrelated source edits to inflate the diff.

## Mandatory telemetry tagging

Every PR (and ADO work item) must be tagged per
[`.github/instructions/telemetry.instructions.md`](instructions/telemetry.instructions.md):
two required labels plus the `pr-telemetry` description footer. Do not skip it, and never
downgrade an `agentic-*` tag to `manual`.

## Definition of Done

A change is done when `npm run build && npm run package && npm run test` all pass, `dist/`
is regenerated, and the telemetry tags/footer are applied. See the
**Verification / Definition of Done** section in [`AGENTS.md`](../AGENTS.md).
