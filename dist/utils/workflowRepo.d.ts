export interface RepoCoords {
    owner: string;
    repo: string;
}
export interface WorkflowRepoInfo extends RepoCoords {
    ref?: string;
}
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
export declare function tryParseWorkflowRepoFromEnv(): WorkflowRepoInfo | undefined;
//# sourceMappingURL=workflowRepo.d.ts.map