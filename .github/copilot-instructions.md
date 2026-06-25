# GitHub Copilot / AI Agent Instructions

These instructions apply to any AI agent (Copilot CLI, Copilot Chat, Claude, Cursor, etc.)
contributing to this repository. Start from [`AGENTS.md`](../AGENTS.md) for the full router
of context, conventions, and the build/test loop.

## Quick orientation

- This is a **TypeScript GitHub Action** (`src/index.ts` → bundled to `dist/` via `ncc`).
- Code style, structure, and test patterns: [`docs/conventions.md`](../docs/conventions.md).
- Build/test loop: `npm run build`, `npm run package`, `npm run test`, `npm run lint`
  (documented in the README **Development** section).
- A `.husky/pre-commit` hook runs tests, rebuilds, and re-stages `dist/` on every commit —
  never hand-edit `dist/`; regenerate it with `npm run build && npm run package`.

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
