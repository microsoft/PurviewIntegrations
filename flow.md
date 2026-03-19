```mermaid
flowchart TD
    trigger[GitHub Action Triggered] --> stateSetup[State Tracking Setup<br/>resolve workflow repo, branch,<br/>detect first run via state file<br/>or workflow history]
    stateSetup --> authenticate[Authenticate → MSAL Token]
    authenticate --> getPrInfo[Get PR Info]
    getPrInfo --> isFirstRun{First Run or<br/>Manual Dispatch?}

    %% ── Full Scan Path (first run only) ──
    isFirstRun -->|Yes| getAllFiles[Get ALL repo files<br/>getAllRepoFiles<br/>binary files auto-skipped]
    getAllFiles --> hasFiles{Files found?}
    hasFiles -->|No| noFilesLog[Log: no files for full scan]
    hasFiles -->|Yes| tenantPS[Call searchTenantProtectionScope<br/>POST .../protectionScopes/compute]
    tenantPS --> tenantPSOk{Tenant PS success?}
    tenantPSOk -->|No| fullScanFallback[Fallback: contentActivities<br/>uploadSignal for ALL files]
    tenantPSOk -->|Yes| tenantHasScopes{Tenant PS has<br/>protection scopes?}
    tenantHasScopes -->|No / empty| fullScanFallback
    tenantHasScopes -->|Yes| groupByUserFull[Group files by userId<br/>authorId or config.userId]
    groupByUserFull --> fullUserPS

    subgraph FULL_SCAN_PER_USER [For each userId — full scan]
        fullUserPS[Call searchUserProtectionScope<br/>POST /users/userId/.../protectionScopes/compute] --> fullUserPSOk{User PS success?}
        fullUserPSOk -->|No / 401| fullIs401{401?}
        fullIs401 -->|Yes| fullCache401[Cache userId in<br/>userPsDeniedCache]
        fullIs401 -->|No| fullUserFallback[Fallback: contentActivities<br/>uploadSignal for user's files]
        fullCache401 --> fullUserFallback
        fullUserPSOk -->|Yes| fullUserHasScopes{User PS has scopes?}
        fullUserHasScopes -->|No / empty| fullUserFallback
        fullUserHasScopes -->|Yes| fullPCABatch[Build PCA batch for user<br/>processContentAsync]
        fullPCABatch --> fullPCAOk{PCA success?}
        fullPCAOk -->|No| fullUserFallback
        fullPCAOk -->|Yes| fullPCADone[Log: PCA complete for user]
    end

    fullScanFallback --> writeState
    fullUserFallback --> writeState
    fullPCADone --> writeState
    writeState[Write state marker<br/>best-effort]
    writeState --> isManualDispatch{Manual Dispatch?}
    isManualDispatch -->|Yes| skipDiff[Log: skipping PR diff]
    isManualDispatch -->|No| getChangedFiles
    noFilesLog --> isManualDispatch

    %% ── PR Diff Path (skipped on manual dispatch) ──
    isFirstRun -->|No| getChangedFiles
    getChangedFiles[Get PR changed files<br/>getLatestPushFiles<br/>binary files auto-skipped]
    getChangedFiles --> hasChangedFiles{Changed files found?}
    hasChangedFiles -->|No| noChangedFilesLog[Log: no changed files]
    hasChangedFiles -->|Yes| groupByUserDiff[Group files by userId<br/>authorId or config.userId]
    groupByUserDiff --> checkDeniedCache

    subgraph PER_USER [For each userId]
        checkDeniedCache{userId in<br/>userPsDeniedCache?} -->|Yes| diffUserFallback[Fallback: contentActivities<br/>uploadSignal for user's files]
        checkDeniedCache -->|No| diffUserPS[Call searchUserProtectionScope<br/>POST /users/userId/.../protectionScopes/compute<br/>capture etag]
        diffUserPS --> diffUserPSOk{User PS success?}
        diffUserPSOk -->|No / 401| diffIs401{401?}
        diffIs401 -->|Yes| diffCache401[Cache userId in<br/>userPsDeniedCache]
        diffCache401 --> diffUserFallback
        diffIs401 -->|No| diffUserFallback
        diffUserPSOk -->|Yes| diffUserHasScopes{User PS response has scopes?}
        diffUserHasScopes -->|No / empty| diffNoScopesFallback[Route all files →<br/>contentActivities<br/>uploadSignal per file]
        diffUserHasScopes -->|Yes| checkScopes[checkApplicableScopes<br/>activity match + location match]
        checkScopes --> shouldProcess{shouldProcess?}
        shouldProcess -->|No| diffNoScopesFallback
        shouldProcess -->|Yes| execMode{executionMode?}

        execMode -->|evaluateInline| processContent[Per-file: processContent<br/>POST /users/userId/.../processContent<br/>If-None-Match: etag<br/>Prefer: evaluateInline]
        processContent --> pcOk{PC success?}
        pcOk -->|No| pcFallback[Fallback: contentActivities<br/>uploadSignal for file]
        pcOk -->|Yes| scopeState{protectionScopeState?}
        scopeState -->|modified| refetchAndRetry[Re-fetch userPS<br/>retry processContent<br/>with fresh etag]
        scopeState -->|notModified| parsePolicyActions[Parse policyActions]
        refetchAndRetry --> parsePolicyActions
        parsePolicyActions --> isBlocked{blockAccess or<br/>restrictionAction=block?}
        isBlocked -->|Yes| addToBlocked[Add to blockedFiles]
        isBlocked -->|No| continueInline[Continue]

        execMode -->|evaluateOffline| pcaBatch[PCA batch for user<br/>processContentAsync]
        pcaBatch --> pcaBatchOk{PCA success?}
        pcaBatchOk -->|No| pcaBatchFallback[Fallback: contentActivities<br/>uploadSignal for user's files]
        pcaBatchOk -->|Yes| continueOffline[Continue]
    end

    diffUserFallback --> nextUser[Next user / done]
    diffNoScopesFallback --> nextUser
    pcFallback --> nextUser
    addToBlocked --> nextUser
    continueInline --> nextUser
    pcaBatchFallback --> nextUser
    continueOffline --> nextUser

    nextUser --> hasBlockedFiles{blockedFiles<br/>not empty?}
    hasBlockedFiles -->|Yes| postPrComment[Post PR review comment<br/>pulls.createReview<br/>blocked file details table]
    hasBlockedFiles -->|No| continueToOutputs[Continue]
    postPrComment --> continueToOutputs

    noChangedFilesLog --> setOutputs
    skipDiff --> setOutputs
    continueToOutputs --> setOutputs[Set action outputs<br/>processed-files, failed-requests,<br/>blocked-files JSON]
    setOutputs --> writeSummary[Write Job Summary<br/>file count + failures +<br/>blocked files table]
    writeSummary --> hasBlockedFinal{blockedFiles<br/>count > 0?}
    hasBlockedFinal -->|Yes| actionFailed[core.setFailed<br/>Action FAILED:<br/>blocked files detected]
    hasBlockedFinal -->|No| actionSucceeded[Action succeeded]

    style processContent fill:#f9a825,color:#000
    style pcaBatch fill:#66bb6a,color:#000
    style fullPCABatch fill:#66bb6a,color:#000
    style diffNoScopesFallback fill:#42a5f5,color:#fff
    style fullScanFallback fill:#42a5f5,color:#fff
    style fullUserFallback fill:#42a5f5,color:#fff
    style diffUserFallback fill:#42a5f5,color:#fff
    style pcFallback fill:#42a5f5,color:#fff
    style pcaBatchFallback fill:#42a5f5,color:#fff
    style addToBlocked fill:#ef5350,color:#fff
    style postPrComment fill:#ef5350,color:#fff
    style actionFailed fill:#ef5350,color:#fff
    style fullCache401 fill:#ff9800,color:#000
    style diffCache401 fill:#ff9800,color:#000
```

### Legend
- 🟡 **Yellow** — processContent (PC) inline: synchronous, per-user, can detect blocks
- 🟢 **Green** — processContentAsync (PCA) batch: fire-and-forget
- 🔵 **Blue** — contentActivities (uploadSignal): fire-and-forget, fallback on failures
- 🔴 **Red** — Block detection, PR review comment & action failure
- 🟠 **Orange** — 401 denial cache (skip user on subsequent calls)
-  **Purple** — External API calls (Graph API user lookup, GitHub API users.json fetch)