# PurviewWorkflow

This repo runs the shared **Purview GitHub Action** from [PurviewTest2/purview-github-action](https://github.com/PurviewTest2/purview-github-action).
    
## Workflow

See [.github/workflows/purview-scan.yml](.github/workflows/purview-scan.yml). It calls the action directly via `uses: PurviewTest2/purview-github-action@main`.

## Parameters

### Required

| Parameter | Description |
|-----------|-------------|
| `client-id` | Azure AD application client ID (GUID). |
| `tenant-id` | Azure AD tenant ID (GUID). |

### Optional

| Parameter | Description | Default |
|-----------|-------------|---------|
| `client-certificate` | PEM containing private key + certificate. If omitted, GitHub OIDC federated credentials are used. | — |
| `users-json-path` | Path to `users.json` (relative to workspace root) that maps commit author emails to Azure AD user IDs. | `users.json` |
| `file-patterns` | Comma-separated glob patterns of files to scan. | `**` |
| `exclude-patterns` | Comma-separated glob patterns of files to exclude. | empty |
| `max-file-size` | Maximum file size in bytes to process. | `10485760` (10 MB) |
| `state-repo-token` | Token with `contents:write` access to this repo. Enables first-run detection so the action performs a full scan once, then only scans deltas. | — |
| `state-repo-branch` | Branch where the state marker file is written. | repo default branch |
| `debug` | Enable verbose debug logging. | `false` |

### `users.json`

Place a `users.json` file in the repo root to map commit author emails to Azure AD user IDs:

```json
{
  "users": [
    { "email": "alice@contoso.com", "userId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    { "email": "bob@contoso.com",   "userId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }
  ],
  "defaultUserId": "00000000-0000-0000-0000-000000000000"
}
```

For each commit, the action checks the author's email against the `users` array. If a match is found that user ID is used; otherwise `defaultUserId` is used. The chosen value is logged.

## Required secrets

Create these repository secrets in **Settings → Secrets and variables → Actions**:

| Secret | Purpose |
|--------|---------|
| `AZURE_CLIENT_ID` | Azure AD application client ID |
| `AZURE_TENANT_ID` | Azure AD tenant ID |
| `AZURE_CLIENT_CERTIFICATE` | *(Optional)* PEM for certificate auth — omit to use GitHub OIDC |
| `STATE_REPO_TOKEN` | *(Optional)* PAT or GitHub App token with `contents:write` for first-run state tracking |