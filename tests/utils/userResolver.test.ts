// Mock @actions/core before importing anything that uses it
jest.mock('@actions/core', () => ({
  getBooleanInput: jest.fn().mockReturnValue(false),
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
}));

import { UserResolver } from '../../src/utils/userResolver';
import { UsersConfig } from '../../src/config/types';
import * as fs from 'fs';
import * as path from 'path';

describe('UserResolver', () => {
  const usersConfig: UsersConfig = {
    users: [
      { email: 'alice@contoso.com', userId: 'user-alice-id' },
      { email: 'bob@contoso.com', userId: 'user-bob-id' },
    ],
    defaultUserId: 'default-user-id',
  };

  describe('constructor', () => {
    it('creates resolver with user mappings', () => {
      const resolver = new UserResolver(usersConfig);
      expect(resolver).toBeInstanceOf(UserResolver);
    });

    it('creates resolver with empty users array', () => {
      const config: UsersConfig = { users: [], defaultUserId: 'default-id' };
      const resolver = new UserResolver(config);
      expect(resolver.resolve('unknown@test.com')).toBe('default-id');
    });
  });

  describe('resolve', () => {
    let resolver: UserResolver;

    beforeEach(() => {
      resolver = new UserResolver(usersConfig);
    });

    it('resolves known email to mapped userId', () => {
      expect(resolver.resolve('alice@contoso.com')).toBe('user-alice-id');
    });

    it('resolves email case-insensitively', () => {
      expect(resolver.resolve('ALICE@CONTOSO.COM')).toBe('user-alice-id');
      expect(resolver.resolve('Alice@Contoso.Com')).toBe('user-alice-id');
    });

    it('returns defaultUserId for unknown email', () => {
      expect(resolver.resolve('unknown@example.com')).toBe('default-user-id');
    });

    it('returns defaultUserId for null email', () => {
      expect(resolver.resolve(null)).toBe('default-user-id');
    });

    it('returns defaultUserId for undefined email', () => {
      expect(resolver.resolve(undefined)).toBe('default-user-id');
    });

    it('returns defaultUserId for empty string email', () => {
      expect(resolver.resolve('')).toBe('default-user-id');
    });

    it('resolves second mapping correctly', () => {
      expect(resolver.resolve('bob@contoso.com')).toBe('user-bob-id');
    });
  });

  describe('loadFromFile', () => {
    const tmpDir = path.join(__dirname, '..', '..', 'tests', '.tmp');
    const tmpFile = path.join(tmpDir, 'users-test.json');

    beforeAll(() => {
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
    });

    afterAll(() => {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    });

    it('loads valid users.json file', () => {
      const data: UsersConfig = {
        users: [{ email: 'test@test.com', userId: 'test-id' }],
        defaultUserId: 'default-test-id',
      };
      fs.writeFileSync(tmpFile, JSON.stringify(data), 'utf-8');

      const resolver = UserResolver.loadFromFile(tmpFile);
      expect(resolver.resolve('test@test.com')).toBe('test-id');
      expect(resolver.resolve('other@test.com')).toBe('default-test-id');
    });

    it('throws when file does not exist', () => {
      expect(() => UserResolver.loadFromFile('/nonexistent/users.json')).toThrow(
        /users\.json not found/
      );
    });

    it('throws when defaultUserId is missing', () => {
      const data = { users: [] as any[], defaultUserId: '' };
      fs.writeFileSync(tmpFile, JSON.stringify(data), 'utf-8');
      expect(() => UserResolver.loadFromFile(tmpFile)).toThrow(/defaultUserId/);
    });

    it('throws when users array is missing', () => {
      const data = { defaultUserId: 'abc' };
      fs.writeFileSync(tmpFile, JSON.stringify(data), 'utf-8');
      expect(() => UserResolver.loadFromFile(tmpFile)).toThrow(/users.*array/);
    });
  });
});
