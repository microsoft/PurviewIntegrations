import { ProcessContentResponse, PolicyAction } from '../config/types';
/**
 * Determines whether a ProcessContent response contains a block action.
 * Mirrors the Python agent-framework pattern:
 * - action === "blockAccess"
 * - restrictionAction === "block"
 */
export declare function isBlocked(response: ProcessContentResponse): boolean;
/**
 * Extracts blocking policy actions from a ProcessContent response.
 */
export declare function getBlockingActions(response: ProcessContentResponse): PolicyAction[];
//# sourceMappingURL=blockDetector.d.ts.map