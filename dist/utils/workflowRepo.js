"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tryParseWorkflowRepoFromEnv = tryParseWorkflowRepoFromEnv;
/**
 * Parse the workflow-definition repository coordinates from the
 * GITHUB_WORKFLOW_REF environment variable.
 *
 * Example values:
 *   Org/WorkflowRepo/.github/workflows/workflow.yml@refs/heads/main
 *   Org/CallerRepo/.github/workflows/workflow.yml@v1
 *
 * Returns undefined when the variable is missing or unparseable.
 */
function tryParseWorkflowRepoFromEnv() {
    const workflowRef = (process.env['GITHUB_WORKFLOW_REF'] || '').trim();
    if (!workflowRef) {
        return undefined;
    }
    const beforeAt = workflowRef.split('@', 1)[0] || '';
    const afterAt = workflowRef.includes('@')
        ? workflowRef.slice(workflowRef.indexOf('@') + 1)
        : undefined;
    const parts = beforeAt.split('/').filter(Boolean);
    if (parts.length < 2) {
        return undefined;
    }
    return { owner: parts[0], repo: parts[1], ref: afterAt };
}
//# sourceMappingURL=workflowRepo.js.map