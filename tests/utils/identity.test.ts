import { normalizeEmail, isUserId } from '../../src/utils/identity';

describe('identity input validation', () => {
  describe('normalizeEmail', () => {
    it('lowercases and trims a valid address', () => {
      expect(normalizeEmail('  Alice@Contoso.COM ')).toBe('alice@contoso.com');
    });

    it.each([
      null,
      undefined,
      '',
      'not-an-email',
      'a@b',
      'alice@contoso.com; rm -rf /',
      'alice@@contoso.com',
      'ali ce@contoso.com',
      `alice@contoso.com' or userPrincipalName ne '`,
      `${'a'.repeat(250)}@contoso.com`,
    ])('rejects %p', (value) => {
      expect(normalizeEmail(value as string | null | undefined)).toBeUndefined();
    });
  });

  describe('isUserId', () => {
    it('accepts an Entra object ID', () => {
      expect(isUserId('11111111-2222-4333-8444-555555555555')).toBe(true);
    });

    it.each([null, undefined, '', 'default-user-id', '../../someone-else', '11111111-2222-4333-8444'])(
      'rejects %p',
      (value) => {
        expect(isUserId(value as string | null | undefined)).toBe(false);
      }
    );
  });
});
