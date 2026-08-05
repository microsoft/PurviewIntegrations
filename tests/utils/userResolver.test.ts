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
      { email: 'alice@contoso.com', userId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' },
      { email: 'bob@contoso.com', userId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' },
    ],
    defaultUserId: 'dddddddd-0000-4000-8000-dddddddddddd',
  };

  describe('constructor', () => {
    it('creates resolver with user mappings', () => {
      const resolver = new UserResolver(usersConfig);
      expect(resolver).toBeInstanceOf(UserResolver);
    });

    it('creates resolver with empty users array', () => {
      const config: UsersConfig = { users: [], defaultUserId: 'eeeeeeee-0000-4000-8000-eeeeeeeeeeee' };
      const resolver = new UserResolver(config);
      expect(resolver.resolve('unknown@test.com')).toBe('eeeeeeee-0000-4000-8000-eeeeeeeeeeee');
    });
  });

  describe('resolve', () => {
    let resolver: UserResolver;

    beforeEach(() => {
      resolver = new UserResolver(usersConfig);
    });

    it('resolves known email to mapped userId', () => {
      expect(resolver.resolve('alice@contoso.com')).toBe('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    });

    it('resolves email case-insensitively', () => {
      expect(resolver.resolve('ALICE@CONTOSO.COM')).toBe('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
      expect(resolver.resolve('Alice@Contoso.Com')).toBe('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    });

    it('returns defaultUserId for unknown email', () => {
      expect(resolver.resolve('unknown@example.com')).toBe('dddddddd-0000-4000-8000-dddddddddddd');
    });

    it('returns defaultUserId for null email', () => {
      expect(resolver.resolve(null)).toBe('dddddddd-0000-4000-8000-dddddddddddd');
    });

    it('returns defaultUserId for undefined email', () => {
      expect(resolver.resolve(undefined)).toBe('dddddddd-0000-4000-8000-dddddddddddd');
    });

    it('returns defaultUserId for empty string email', () => {
      expect(resolver.resolve('')).toBe('dddddddd-0000-4000-8000-dddddddddddd');
    });

    it('resolves second mapping correctly', () => {
      expect(resolver.resolve('bob@contoso.com')).toBe('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb');
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
        users: [{ email: 'test@test.com', userId: 'ffffffff-0000-4000-8000-ffffffffffff' }],
        defaultUserId: 'cccccccc-0000-4000-8000-cccccccccccc',
      };
      fs.writeFileSync(tmpFile, JSON.stringify(data), 'utf-8');

      const resolver = UserResolver.loadFromFile(tmpFile);
      expect(resolver.resolve('test@test.com')).toBe('ffffffff-0000-4000-8000-ffffffffffff');
      expect(resolver.resolve('other@test.com')).toBe('cccccccc-0000-4000-8000-cccccccccccc');
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
