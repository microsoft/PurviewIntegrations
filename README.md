# Purview GitHub Action

A GitHub Action that scans repository files and sends them to Azure Purview for data governance and compliance tracking.

## Features

- 🔐 **Secure Authentication**: Uses GitHub OIDC for passwordless Azure authentication
- 📁 **Smart File Processing**: Automatically detects and processes changed files
- 🔄 **Resilient API Integration**: Built-in retry logic with exponential backoff
- 📊 **Comprehensive Logging**: Detailed execution logs with sensitive data redaction
- 🚀 **Enterprise Ready**: Handles large repositories with chunking and streaming

## Prerequisites

1. Azure AD Application with federated credentials configured for GitHub OIDC
2. Purview account with API access enabled
3. GitHub repository with OIDC permissions

## Auth Setup
1. Create an app registration in entra with the following permissions:
  * ContentActivity.Write (Application)
  * Content.Process.User (Application)
  * ProtectionScopes.Compute.All (Application)
2. Grant admin content to those permissions
3. In that app registration, click the "Certificates & secrets" tab, then click the "Federated credentials" tab, and click "Add credential"
4. Choose "Other issuer" from the "Federated credential scenario" dropdown.
5. Set Issuer to https://token.actions.githubusercontent.com
6. Set Type to "Claims matching expression"
7. Set "Value" to `claims['sub'] matches 'repo:{your-user-or-org-name}/{your-repo-name}:*'` replacing the sections in curly braces with the values for your repo.
8. Set Name and Description.
9. Set "Audience" to api://AzureADTokenExchange if not already set.
10. Click "Add".

## Usage

```yaml
name: Scan with Purview
on:
  push:
    branches: [main]
  pull_request:

permissions:
  id-token: write
  contents: read
  pull-requests: read

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
          
      - uses: microsoft/purview-github-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          client-certificate: ${{ secrets.AZURE_CLIENT_CERTIFICATE }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          users-json-path: 'users.json'
          file-patterns: '**'
          debug: true
```

### User ID resolution via `users.json`

Instead of passing a single Azure AD user ID, the action resolves user IDs from a `users.json` file placed in your workflow-definition repo. When the workflow-definition repo differs from the target repo being scanned (cross-repo workflow), the action automatically fetches `users.json` from the workflow-definition repo via the GitHub API using the `state-repo-token`. When the workflow repo is the same as the target repo, the file is read from the local filesystem (`$GITHUB_WORKSPACE`).

The file maps commit author emails to Azure AD user IDs:

```json
{
  "users": [
    { "email": "alice@contoso.com", "userId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    { "email": "bob@contoso.com",   "userId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }
  ],
  "defaultUserId": "00000000-0000-0000-0000-000000000000"
}
```

For each commit author, the action checks the email against the `users` array. If a match is found that user ID is used; otherwise the `defaultUserId` is used. The chosen value is logged for every commit.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `client-id` | Azure AD application client ID | Yes | - |
| `client-certificate` | PEM containing private key + certificate for certificate-based auth. If omitted, uses GitHub OIDC federated credentials. | No | - |
| `tenant-id` | Azure AD tenant ID | Yes | - |
| `users-json-path` | Path to `users.json` in the workflow-definition repo (relative to repo root). In cross-repo workflows the file is fetched via the GitHub API using `state-repo-token`. | No | `users.json` |
| `purview-account-name` | Name of the Purview account | No | - |
| `purview-endpoint` | Purview API endpoint URL | No | `https://graph.microsoft.com/v1.0` |
| `file-patterns` | Comma-separated file patterns to scan | No | `**` |
| `exclude-patterns` | Comma-separated file patterns to exclude from scanning | No | empty |
| `max-file-size` | Maximum file size in bytes | No | `10485760` (10MB) |
| `debug` | Enable debug logging | No | `false` |
| `state-repo-branch` | Branch in the workflow-definition repo where the state marker is written | No | repo default branch |
| `state-repo-token` | Token with `contents:write` access to the workflow-definition repo. Used for first-run state tracking and for fetching `users.json` in cross-repo workflows. | No | empty |

### File pattern examples

Patterns are standard glob patterns and should use `/` as the path separator.

Scan only specific extensions:

```yaml
with:
  file-patterns: "**/*.md,**/*.yml,**/*.yaml,**/*.json"
```

Scan a single folder (and everything under it):

```yaml
with:
  file-patterns: "src/**"
```

Exclude common folders (even if included by `file-patterns`):

```yaml
with:
  file-patterns: "**/*"
  exclude-patterns: "**/node_modules/**,**/dist/**,**/build/**,**/.git/**"
```

Exclude a specific folder and file type:

```yaml
with:
  file-patterns: "**/*"
  exclude-patterns: ".github/**,**/*.lock"
```

### First-run state tracking

When `state-repo-token` is provided, the action stores a marker file (`.purview/state/<owner>-<repo>.json`) in the workflow-definition repo. On the first run it performs a full repository scan; subsequent runs only process changed files. The scanned repository only needs `contents: read` — the action never writes files back into it.

## Outputs

| Output | Description |
|--------|-------------|
| `processed-files` | Number of files successfully processed |
| `failed-requests` | Number of files that failed processing |
| `conversation-id` | Purview conversation ID for tracking |

## Architecture

The action follows a modular architecture with clear separation of concerns:

- **Authentication Service**: Handles OIDC token exchange and caching
- **File Processor**: Manages file discovery and content extraction
- **Purview Client**: Implements API communication with retry logic
- **Payload Builder**: Constructs optimized payloads with chunking
- **Logger**: Provides structured logging with sensitive data protection

## Security Considerations

- All authentication tokens are handled securely and never logged
- Sensitive data is automatically redacted from error messages
- API communications use TLS and follow zero-trust principles
- File contents are validated before processing

## Error Handling

The action implements comprehensive error handling:

- Network failures trigger automatic retries with exponential backoff
- Rate limiting is respected with proper delay handling
- File processing errors are isolated and don't stop the entire scan
- All errors include actionable context for debugging

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Package for distribution
npm run package

# Run tests
npm run test

# Lint code
npm run lint
```

## Troubleshooting

### Authentication Failures
- Ensure the Azure AD app has proper federated credentials or a valid client certificate
- Verify OIDC permissions (`id-token: write`) are granted in the workflow
- Check that the `users.json` file exists and has a valid `defaultUserId`

### API Errors
- Verify the Purview endpoint URL is correct
- Ensure the service principal has proper Purview permissions
- Check for rate limiting in debug logs

### File Processing Issues
- Review file patterns match your repository structure
- Check file size limits for large files
- Ensure files are UTF-8 encoded

## License

This project is licensed under the MIT License.