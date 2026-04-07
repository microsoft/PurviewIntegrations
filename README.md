# Purview GitHub Action

A GitHub Action that scans repository files and sends them to Azure Purview for data governance and compliance tracking.

## Features

- 🔐 **Secure Authentication**: Uses GitHub OIDC for passwordless Azure authentication
- 📁 **Smart File Processing**: Automatically detects and processes changed files; binary files are skipped
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
  * (Optional, used for user id lookup) User.Read.All (Application)
2. Grant admin consent to those permissions
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
  workflow_dispatch:  # Allow manual triggering for full scans

permissions:
  id-token: write
  contents: read
  pull-requests: write
  actions: read

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
| `client-secret` | Azure AD application client secret for secret-based auth. If omitted, uses GitHub OIDC federated credentials. | No | - |
| `tenant-id` | Azure AD tenant ID | Yes | - |
| `users-json-path` | Path to `users.json` in the workflow-definition repo (relative to repo root). In cross-repo workflows the file is fetched via the GitHub API using `state-repo-token`. | No | `users.json` |
| `purview-account-name` | Name of the Purview account | No | - |
| `purview-endpoint` | Purview API endpoint URL | No | `https://graph.microsoft.com/v1.0` |
| `file-patterns` | Comma-separated file patterns to scan | No | `**` |
| `exclude-patterns` | Comma-separated file patterns to exclude from scanning | No | `**/.git/**` |
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

If state repo tracking is not configured, the action queries the repo's workflow history to check if it has been run before. If the action has not been run before, or if previous runs have all failed, it will perform a full scan.

### Manual full scan

You can trigger a complete repository scan by running the workflow manually via `workflow_dispatch`. This is useful when:

- You want to re-scan all files after updating Purview policies
- You need to ensure full compliance after security changes
- You're troubleshooting issues and want to reprocess everything

Simply add `workflow_dispatch` to your workflow triggers and run it manually from the GitHub Actions tab:

```yaml
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:  # Enables manual triggering for full scans
```

When triggered via `workflow_dispatch`, the action will automatically perform a full repository scan regardless of state tracking.

## Outputs

| Output | Description |
|--------|-------------|
| `processed-files` | Number of files successfully processed |
| `failed-requests` | Number of files that failed processing |
| `blocked-files` | JSON array of file paths that were blocked by data security policies |

## Architecture

The action follows a modular architecture with clear separation of concerns:

- **Authentication Service**: Handles OIDC token exchange, certificate-based, and client-secret authentication via MSAL, with token caching and refresh
- **File Processor**: Manages file discovery, content extraction, binary detection, and diff computation (LCS-based)
- **Purview Client**: Implements API communication with retry logic and exponential backoff for processContent, processContentAsync, contentActivities, and protection scope endpoints
- **Payload Builder**: Constructs optimized payloads with chunking (content ≤ 3 MB, request ≤ 3.7 MB, max 64 items per batch)
- **Full Scan Service**: Orchestrates first-run full repository scans including state tracking, tenant/user protection scope resolution, and commit processing
- **Block Detector**: Identifies `blockAccess` and `restrict → block` policy actions from processContent responses
- **PR Comment Service**: Posts PR review comments listing blocked files when data security policies trigger block actions
- **User Resolver**: Maps commit author emails to Azure AD user IDs via `users.json` mappings and Microsoft Graph API lookups with caching
- **State Service**: Manages first-run state markers (`.purview/state/<owner>-<repo>.json`) in the workflow-definition repository
- **Retry Handler**: Provides exponential backoff retry strategy with jitter for transient failures (429, 5xx, network errors)
- **Logger**: Provides structured logging with sensitive data redaction

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
- Binary files (images, executables, etc.) are automatically detected and skipped

## License

This project is licensed under the MIT License.

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to
agree to a Contributor License Agreement (CLA) declaring that you have the right to,
and actually do, grant us the rights to use your contribution. For details, visit
https://cla.microsoft.com.

When you submit a pull request, a CLA-bot will automatically determine whether you need
to provide a CLA and decorate the PR appropriately (e.g., label, comment). Simply follow the
instructions provided by the bot. You will only need to do this once across all repositories using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/)
or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.