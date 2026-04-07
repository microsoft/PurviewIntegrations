# Setup Purview & GitHub

This guide walks you through everything needed to connect your GitHub organization's repositories to Microsoft Purview using the **Purview GitHub Action**. Every push or pull request on your chosen repos will automatically scan files and send them to Purview for data governance and compliance tracking.

---

## Table of Contents

- [Setup Purview \& GitHub](#setup-purview--github)
  - [Table of Contents](#table-of-contents)
  - [1. Prerequisites](#1-prerequisites)
  - [2. Create an Entra App Registration \& Add Permissions](#2-create-an-entra-app-registration--add-permissions)
    - [Add API Permissions](#add-api-permissions)
  - [3. Configure Authentication](#3-configure-authentication)
    - [Option A: Certificate-Based Authentication](#option-a-certificate-based-authentication)
    - [Option B: Client-Secret Authentication](#option-b-client-secret-authentication)
  - [4. Create the Workflow Repository](#4-create-the-workflow-repository)
  - [5. Add GitHub Secrets](#5-add-github-secrets)
    - [Generating a Certificate for GitHub Secrets](#generating-a-certificate-for-github-secrets)
    - [Creating the `STATE_REPO_TOKEN`](#creating-the-state_repo_token)
      - [Option A: Fine-Grained Personal Access Token (Recommended)](#option-a-fine-grained-personal-access-token-recommended)
      - [Option B: Classic Personal Access Token](#option-b-classic-personal-access-token)
      - [Store the Token as a GitHub Secret](#store-the-token-as-a-github-secret)
      - [Using a GitHub App Token (Alternative)](#using-a-github-app-token-alternative)
  - [6. Install the GitHub Action Workflow](#6-install-the-github-action-workflow)
    - [Quick Start: Minimal Workflow](#quick-start-minimal-workflow)
    - [Full Workflow: All Options](#full-workflow-all-options)
  - [7. Verify the Setup](#7-verify-the-setup)
  - [8. Enforce the Workflow Across the Organization](#8-enforce-the-workflow-across-the-organization)
  - [Appendix: OIDC Federated Credential Authentication](#appendix-oidc-federated-credential-authentication)
    - [Configure Federated Credentials](#configure-federated-credentials)
    - [OIDC Workflow](#oidc-workflow)

---

## 1. Prerequisites

Before you begin, make sure you have the following:

- **Microsoft Purview** — an active account at [purview.microsoft.com](https://purview.microsoft.com)
- **Microsoft Entra ID (Azure AD)** — ability to create App Registrations and grant admin consent
- **GitHub organization** (or personal account) with admin access to the target repositories

---

## 2. Create an Entra App Registration & Add Permissions

1. Go to [Microsoft Entra ID → App registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade/quickStartType~/null/isMSAApp~/false).
2. Click **+ New registration**.
3. Enter a name (e.g., `Purview GitHub Action`) and select the appropriate supported account type (typically **Single tenant**).
4. Click **Register**.
5. After the app is created, note the following values from the **Overview** page — you will need them later:
   - **Application (client) ID**

### Add API Permissions

6. In the app registration, navigate to **API permissions** → **+ Add a permission**.
7. Select **Microsoft Graph**.
8. Add the following **Application** permissions:
   - `ContentActivity.Write`
   - `Content.Process.User`
   - `ProtectionScopes.Compute.All`
9. If the committers to your repo will be using email addresses associated with your tenant, add the `User.Read.All` Application permission.
10. Click **Grant admin consent for \<your tenant\>** and confirm.

---

## 3. Configure Authentication

Choose one of the following authentication methods for the action to authenticate against Entra ID.

### Option A: Certificate-Based Authentication

1. Generate a self-signed certificate (see [Generating a Certificate for GitHub Secrets](#generating-a-certificate-for-github-secrets) below for OpenSSL commands).
2. In your App Registration, go to **Certificates & secrets** → **Certificates** tab.
3. Click **Upload certificate** and upload the public certificate file (`.cer` or `.pem`).
4. Store the full PEM file (private key + certificate combined) as a GitHub secret named `AZURE_CLIENT_CERTIFICATE` (see [Step 5](#5-add-github-secrets)).

### Option B: Client-Secret Authentication

1. In your App Registration, go to **Certificates & secrets** → **Client secrets** tab.
2. Click **+ New client secret**.
3. Provide a description (e.g., `Purview GitHub Action`) and select an expiration period.
4. Click **Add**.
5. Copy the **Value** of the newly created secret immediately — it will not be shown again.
6. Store this value as a GitHub secret named `AZURE_CLIENT_SECRET` (see [Step 5](#5-add-github-secrets)), then pass it via the `client-secret` action input.

---

## 4. Create the Workflow Repository

Create a dedicated repository in your organization to host the reusable Purview scan workflow. This repository will contain the workflow definition that other repositories reference.

1. In your GitHub organization, create a new repository (e.g., `purview-workflow`).

2. **Set the repository visibility to `Internal`** (recommended) or `Public`.
   - Private repositories **cannot** be used as a required workflow source in organization rulesets.
   - Go to **Repository → Settings → General → Danger Zone → Change repository visibility** and select **Internal**.

3. **Enable GitHub Actions** for the repository.
   - Go to **Repository → Settings → Actions → General**.
   - Under **Actions permissions**, select **Allow all actions and reusable workflows** (or scope to specific actions as needed).

4. **Allow access from other repositories in the organization.**
   - On the same page (**Settings → Actions → General**), scroll to the **Access** section.
   - Select **Accessible from repositories in the '\<your-org\>' organization**.
   - Click **Save**.

   > This is the most commonly missed step. Without it, other repositories in the organization cannot reference workflows from this repository, and the ruleset will fail to trigger the required workflow.

5. In this repository, create the file `.github/workflows/purview-scan.yml` with the workflow definition from [Step 6](#6-install-the-github-action-workflow).

6. **Push to the default branch** (e.g., `main`).
   - Organization rulesets reference the workflow file on the default branch. The workflow file must be merged to the default branch before it can be selected in a ruleset.

The workflow supports multiple trigger events depending on your governance requirements:

| Trigger | Description |
|---------|-------------|
| `pull_request` | Scans files when a pull request is opened or updated against the target branch. Ideal for pre-merge compliance checks. |
| `push` | Scans files on every push to the specified branch (e.g., `main`). Useful for post-merge auditing. |
| `schedule` | Runs the scan on a cron schedule (e.g., nightly). Suitable for periodic full-repository scans. |
| `workflow_dispatch` | Allows manual triggering from the GitHub Actions UI. Useful for on-demand scans and testing. |

You can combine multiple triggers in a single workflow. See the workflow examples in [Step 6](#6-install-the-github-action-workflow) for the full configuration.

---

## 5. Add GitHub Secrets

Each organization that uses the Purview action needs the following secrets configured. Organization-level secrets allow you to configure these once and share them across all repositories.

1. Go to your GitHub **Organization** → **Settings** → **Secrets and variables** → **Actions**.
2. Click **New organization secret** and add each of the following:

   | Secret Name | Value | Required |
   |-------------|-------|----------|
   | `AZURE_CLIENT_ID` | The **Application (client) ID** from your Entra App Registration | Yes |
   | `AZURE_TENANT_ID` | The **Directory (tenant) ID** from your Entra App Registration | Yes |
   | `AZURE_CLIENT_CERTIFICATE` | Full PEM file contents (private key + certificate) — **only if using certificate auth** | Conditional |
   | `AZURE_CLIENT_SECRET` | The **Client Secret** value from your Entra App Registration — **only if using client-secret auth** (passed via the `client-secret` action input) | Conditional |
   | `STATE_REPO_TOKEN` | A **Personal Access Token** or **Fine-Grained Token** with `contents:write` to the workflow repository (for state tracking) | Optional |

3. Set the **Repository access** policy to grant access to the repositories that will run the workflow.

> **Note:** You can also configure these as repository-level secrets under **Repository → Settings → Secrets and variables → Actions** if you prefer per-repo isolation.

### Generating a Certificate for GitHub Secrets

Use the following OpenSSL commands to generate a self-signed certificate suitable for Entra App Registration and GitHub Actions:

```bash
# 1. Generate a private key
openssl genrsa -out purview-action.key 2048

# 2. Generate a self-signed certificate (valid for 1 year)
openssl req -new -x509 -key purview-action.key -out purview-action.crt -days 365 \
  -subj "/CN=PurviewGitHubAction"

# 3. Combine the private key and certificate into a single PEM file
#    This combined file is what you store as the AZURE_CLIENT_CERTIFICATE secret
cat purview-action.key purview-action.crt > purview-action.pem

# 4. (Optional) Verify the certificate
openssl x509 -in purview-action.crt -text -noout
```

- Upload `purview-action.crt` to your Entra App Registration under **Certificates & secrets** → **Certificates**.
- Copy the full contents of `purview-action.pem` and store it as the `AZURE_CLIENT_CERTIFICATE` GitHub secret.

### Creating the `STATE_REPO_TOKEN`

The state-repo token allows the action to write a state marker file (`.purview/state/<owner>-<repo>.json`) to your workflow repository. This enables **first-run detection** — a full scan runs on the first execution, and only delta (changed-file) scans run thereafter.

You can create either a **Fine-Grained Personal Access Token** (recommended) or a **Classic Personal Access Token**.

#### Option A: Fine-Grained Personal Access Token (Recommended)

Fine-grained tokens follow the principle of least privilege by scoping access to specific repositories and permissions.

1. Go to [GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new).
2. Click **Generate new token**.
3. Fill in the following:

   | Field | Value |
   |-------|-------|
   | **Token name** | `purview-state-repo-token` (or any descriptive name) |
   | **Expiration** | Choose an appropriate expiration (e.g., 90 days, 1 year). Set a reminder to rotate before expiry. |
   | **Resource owner** | Select your **organization** |
   | **Repository access** | Select **Only select repositories** → choose your **workflow repository** (e.g., `purview-workflow`) |

4. Under **Permissions** → **Repository permissions**, set:

   | Permission | Access |
   |------------|--------|
   | **Contents** | **Read and write** |

   Leave all other permissions at **No access**.

5. Click **Generate token**.
6. **Copy the token immediately** — it will not be shown again.

#### Option B: Classic Personal Access Token

1. Go to [GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)](https://github.com/settings/tokens/new).
2. Click **Generate new token (classic)**.
3. Fill in the following:

   | Field | Value |
   |-------|-------|
   | **Note** | `purview-state-repo-token` |
   | **Expiration** | Choose an appropriate expiration |

4. Select the following **scope**:

   | Scope | Purpose |
   |-------|---------|
   | `repo` | Grants read/write access to repository contents |

   > **Note:** Classic tokens cannot be scoped to a single repository. The `repo` scope grants access to all repositories the token owner can access. For tighter security, use a Fine-Grained Token (Option A).

5. Click **Generate token**.
6. **Copy the token immediately** — it will not be shown again.

#### Store the Token as a GitHub Secret

1. Go to your GitHub **Organization** → **Settings** → **Secrets and variables** → **Actions**.
   - Or for repo-level: **Repository** → **Settings** → **Secrets and variables** → **Actions**.
2. Click **New organization secret** (or **New repository secret**).
3. Set:
   - **Name:** `STATE_REPO_TOKEN`
   - **Value:** paste the token you copied
4. Under **Repository access**, grant access to all repositories that will run the Purview scan workflow.
5. Click **Add secret**.

#### Using a GitHub App Token (Alternative)

If your organization restricts personal access tokens, you can use a **GitHub App** to generate installation tokens:

1. Create a GitHub App with **Contents: Read & write** permission.
2. Install the app on the workflow repository.
3. In your workflow, use the [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token) action to generate a short-lived token:

   ```yaml
   - name: Generate app token
     id: app-token
     uses: actions/create-github-app-token@v1
     with:
       app-id: ${{ secrets.APP_ID }}
       private-key: ${{ secrets.APP_PRIVATE_KEY }}
       repositories: purview-workflow  # your workflow repo name

   - name: Run Purview GitHub Action
     uses: PersonalPurview/purview-github-action@main
     with:
       # ...other inputs...
       state-repo-token: ${{ steps.app-token.outputs.token }}
   ```

> **Security best practices:**
> - Prefer **Fine-Grained Tokens** scoped to only the workflow repository.
> - Set the **shortest practical expiration** and rotate tokens before they expire.
> - If using a classic token, consider creating a dedicated **machine user** account to own the token.
> - The token only needs **write access to the workflow repository** — it does not need access to the repositories being scanned.

---

## 6. Install the GitHub Action Workflow

Create the workflow file `.github/workflows/purview-scan.yml` in your workflow repository.

### Quick Start: Minimal Workflow

The following workflow contains only the required inputs using certificate-based authentication. Copy this to get up and running quickly.

```yaml
name: Purview Scan (Action)

on:
  pull_request:
    branches: [main]
  workflow_dispatch:

permissions:
  id-token: write
  contents: read
  pull-requests: write
  actions: read

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run Purview GitHub Action
        uses: PersonalPurview/purview-github-action@main
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          client-certificate: ${{ secrets.AZURE_CLIENT_CERTIFICATE }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
```

### Full Workflow: All Options

The following workflow includes every supported input with inline documentation. It supports both certificate and client-secret authentication — adjust the `env` and `with` sections to match your chosen method.

```yaml
name: Purview Scan (Action)

on:
  # Scan on pull requests targeting main — ideal for pre-merge compliance
  pull_request:
    branches: [main]

  # Scan on push to main — for post-merge auditing
  push:
    branches: [main]

  # Scheduled scan — runs nightly for periodic full-repository scans
  # schedule:
  #   - cron: '0 2 * * *'    # Runs daily at 2:00 AM UTC

  # Manual trigger — for on-demand scans and testing
  workflow_dispatch:

permissions:
  id-token: write       # Required for token exchange
  contents: read        # Required to read repository files
  pull-requests: write  # Required to read pull request metadata and create a comment if anything was blocked
  actions: read         # Required to read history of previous workflow runs

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run Purview GitHub Action
        uses: PersonalPurview/purview-github-action@main
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          # ══════════════════════════════════════
          # Required inputs
          # ══════════════════════════════════════
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}

          # ── Authentication (choose one) ──
          # Certificate auth: provide the PEM secret
          client-certificate: ${{ secrets.AZURE_CLIENT_CERTIFICATE }}
          # Client-secret auth: remove the line above and uncomment the line below
          # client-secret: ${{ secrets.AZURE_CLIENT_SECRET }}
          # OIDC federated auth: remove both lines above and configure federated
          # credentials in your Entra App Registration (see Appendix).

          # ══════════════════════════════════════
          # Optional inputs
          # ══════════════════════════════════════

          # ── File scanning (optional) ──
          file-patterns: '**'                    # Comma-separated glob patterns (e.g., '**/*.md,**/*.json')
          exclude-patterns: '**/.git/**'         # Comma-separated patterns to exclude (e.g., '**/node_modules/**,**/dist/**')
          max-file-size: '10485760'              # Maximum file size in bytes (default: 10 MB)

          # ── State tracking (optional) ──
          # Enables first-run detection: full scan on first run, delta scans thereafter.
          # The state marker is written to .purview/state/<owner>-<repo>.json in the workflow repo.
          # state-repo-token: ${{ secrets.STATE_REPO_TOKEN }}    # Token with contents:write to the workflow repo
          # state-repo-branch: main                              # Branch for the state marker (default: repo default branch)

          # ── Debugging (optional) ──
          debug: true                           # Set to false in production
```

---

## 7. Verify the Setup

After pushing the workflow file, verify everything is working:

1. Go to your repository → **Actions** tab.
2. You should see the **"Purview Scan (Action)"** workflow listed.
3. Trigger a run by pushing a commit, opening a pull request against `main`, or clicking **Run workflow** (if `workflow_dispatch` is enabled).
4. Click into the workflow run and inspect the logs to confirm:
   - Authentication succeeded
   - Files were discovered and processed
   - Payloads were sent to the Purview endpoint

---

## 8. Enforce the Workflow Across the Organization

To require the Purview scan on all repositories (or a subset) in your organization, configure a **repository ruleset** with a required workflow.

1. Go to your GitHub **Organization** → **Settings** → **Repository** → **Rulesets**.
2. Click **New ruleset** → **New branch ruleset**.
3. Configure the ruleset:

   | Setting | Value |
   |---------|-------|
   | **Enforcement status** | Active |
   | **Target repositories** | All repositories (or select specific repositories) |
   | **Target branches** | Default branch (or `main`) |

4. Under **Branch rules**, enable the following:
   - **Require a pull request before merging** — enable this if the workflow is configured to trigger on `pull_request` events, ensuring scans run before code is merged.
   - **Require workflows to pass before merging** — enable this and select **Purview Scan (Action)** as the required workflow.

5. Click **Create** to save the ruleset.

Once active, the Purview scan will be enforced as a required status check. Pull requests that do not pass the scan will be blocked from merging.

---

## Appendix: OIDC Federated Credential Authentication

As an alternative to certificate or client-secret authentication, you can configure **GitHub OIDC federated credentials**. This method eliminates the need to store any secrets for Azure authentication, but requires per-repository federated credential configuration in Entra.

> **Note:** OIDC federated credentials are scoped to a specific repository. You must create a separate federated credential for each repository that will run the action.

### Configure Federated Credentials

1. In your App Registration, go to **Certificates & secrets** → **Federated credentials** tab.
2. Click **+ Add credential**.
3. Select **Other issuer** from the *Federated credential scenario* dropdown.
4. Fill in the following fields:

   | Field | Value |
   |-------|-------|
   | **Issuer** | `https://token.actions.githubusercontent.com` |
   | **Type** | `Claims matching expression` |
   | **Value** | `claims['sub'] matches 'repo:<your-org>/<your-repo>:*'` |
   | **Name** | A friendly name (e.g., `github-purview-oidc`) |
   | **Audience** | `api://AzureADTokenExchange` |

   > Replace `<your-org>` and `<your-repo>` with the actual GitHub organization and repository name.

5. Click **Add**.
6. Repeat for each repository that will use OIDC authentication.

### OIDC Workflow

```yaml
name: Purview Scan (OIDC)

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  id-token: write       # Required for GitHub OIDC token exchange
  contents: read
  pull-requests: write  # Required to read pull request metadata and create a comment if anything was blocked
  actions: read         # Required to read history of previous workflow runs

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Authenticate to Azure via OIDC
        uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          allow-no-subscriptions: true

      - name: Run Purview GitHub Action
        uses: PersonalPurview/purview-github-action@main
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          file-patterns: '**'
          debug: true
```