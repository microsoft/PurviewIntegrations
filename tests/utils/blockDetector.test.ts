import { isBlocked, getBlockingActions } from '../../src/utils/blockDetector';
import { ProcessContentResponse, PolicyAction } from '../../src/config/types';

describe('blockDetector', () => {
  describe('isBlocked', () => {
    it('returns false when policyActions is empty', () => {
      const response: ProcessContentResponse = {
        id: 'resp-1',
        protectionScopeState: 'notModified',
        policyActions: [],
        processingErrors: [],
      };
      expect(isBlocked(response)).toBe(false);
    });

    it('returns false when policyActions is undefined/null', () => {
      const response = {
        id: 'resp-1',
        protectionScopeState: 'notModified',
        policyActions: undefined as unknown as PolicyAction[],
        processingErrors: [],
      } as ProcessContentResponse;
      expect(isBlocked(response)).toBe(false);
    });

    it('returns true when action is blockAccess', () => {
      const response: ProcessContentResponse = {
        id: 'resp-1',
        protectionScopeState: 'notModified',
        policyActions: [
          { action: 'blockAccess', policyName: 'DLP-1' },
        ],
        processingErrors: [],
      };
      expect(isBlocked(response)).toBe(true);
    });

    it('returns true when restrictionAction is block', () => {
      const response: ProcessContentResponse = {
        id: 'resp-1',
        protectionScopeState: 'notModified',
        policyActions: [
          { action: 'restrict', restrictionAction: 'block', policyName: 'DLP-2' },
        ],
        processingErrors: [],
      };
      expect(isBlocked(response)).toBe(true);
    });

    it('returns false when actions are non-blocking', () => {
      const response: ProcessContentResponse = {
        id: 'resp-1',
        protectionScopeState: 'notModified',
        policyActions: [
          { action: 'notify', policyName: 'DLP-3' },
          { action: 'audit', policyName: 'DLP-4' },
        ],
        processingErrors: [],
      };
      expect(isBlocked(response)).toBe(false);
    });

    it('returns true when at least one action is blocking among several', () => {
      const response: ProcessContentResponse = {
        id: 'resp-1',
        protectionScopeState: 'notModified',
        policyActions: [
          { action: 'notify', policyName: 'DLP-A' },
          { action: 'blockAccess', policyName: 'DLP-B' },
          { action: 'audit', policyName: 'DLP-C' },
        ],
        processingErrors: [],
      };
      expect(isBlocked(response)).toBe(true);
    });
  });

  describe('getBlockingActions', () => {
    it('returns empty array when policyActions is undefined', () => {
      const response = {
        id: 'resp-1',
        protectionScopeState: 'notModified',
        policyActions: undefined as unknown as PolicyAction[],
        processingErrors: [],
      } as ProcessContentResponse;
      expect(getBlockingActions(response)).toEqual([]);
    });

    it('returns empty array when no blocking actions exist', () => {
      const response: ProcessContentResponse = {
        id: 'resp-1',
        protectionScopeState: 'notModified',
        policyActions: [
          { action: 'notify', policyName: 'DLP-1' },
        ],
        processingErrors: [],
      };
      expect(getBlockingActions(response)).toEqual([]);
    });

    it('returns only blocking actions', () => {
      const blockAction: PolicyAction = { action: 'blockAccess', policyName: 'DLP-Block' };
      const restrictAction: PolicyAction = { action: 'restrict', restrictionAction: 'block', policyName: 'DLP-Restrict' };
      const notifyAction: PolicyAction = { action: 'notify', policyName: 'DLP-Notify' };

      const response: ProcessContentResponse = {
        id: 'resp-1',
        protectionScopeState: 'notModified',
        policyActions: [blockAction, notifyAction, restrictAction],
        processingErrors: [],
      };

      const result = getBlockingActions(response);
      expect(result).toHaveLength(2);
      expect(result).toContainEqual(blockAction);
      expect(result).toContainEqual(restrictAction);
    });
  });
});
