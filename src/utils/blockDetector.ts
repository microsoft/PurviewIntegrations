import { ProcessContentResponse, PolicyAction } from '../config/types';

/**
 * Determines whether a ProcessContent response contains a block action.
 * Mirrors the Python agent-framework pattern:
 * - action === "blockAccess"
 * - restrictionAction === "block"
 */
export function isBlocked(response: ProcessContentResponse): boolean {
  if (!response.policyActions || response.policyActions.length === 0) {
    return false;
  }

  return response.policyActions.some(
    (pa: PolicyAction) =>
      pa.action === 'blockAccess' || pa.restrictionAction === 'block'
  );
}

/**
 * Extracts blocking policy actions from a ProcessContent response.
 */
export function getBlockingActions(response: ProcessContentResponse): PolicyAction[] {
  if (!response.policyActions) return [];

  return response.policyActions.filter(
    (pa: PolicyAction) =>
      pa.action === 'blockAccess' || pa.restrictionAction === 'block'
  );
}
