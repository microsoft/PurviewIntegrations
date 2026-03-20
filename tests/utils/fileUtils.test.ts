jest.mock('@actions/core', () => ({
  getBooleanInput: jest.fn().mockReturnValue(false),
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

jest.mock('is-binary-path', () => ({
  __esModule: true,
  default: (filePath: string) => /\.(png|jpg|gif|exe|dll|bin|ico|woff|ttf)$/i.test(filePath),
}));

import * as fs from 'fs';
import { createPayloadsFromFile } from '../../src/utils/fileUtils';
import { Logger } from '../../src/utils/logger';
import { ActionConfig } from '../../src/utils/types';

jest.mock('fs');

const mockFs = fs as jest.Mocked<typeof fs>;
const logger = new Logger('test');

function makeConfig(overrides: Partial<ActionConfig> = {}): ActionConfig {
  return {
    endpoint: 'https://example.com',
    userPrincipalName: 'user@test.com',
    tenantId: 'tid',
    aadResource: 'res',
    includeGlobs: ['**'],
    excludeGlobs: [],
    maxFileBytes: 1024,
    sliceLargeFiles: false,
    skipBinary: true,
    includeSummaryPayload: false,
    minify: false,
    failOnNon2xx: false,
    appHostName: 'test',
    applicationHostCategories: [],
    debug: false,
    ...overrides,
  };
}

describe('createPayloadsFromFile', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null for empty files', () => {
    mockFs.statSync.mockReturnValue({ size: 0 } as fs.Stats);
    expect(createPayloadsFromFile('empty.txt', makeConfig(), logger)).toBeNull();
  });

  it('returns null for binary files when skipBinary is true', () => {
    mockFs.statSync.mockReturnValue({ size: 100 } as fs.Stats);
    expect(createPayloadsFromFile('image.png', makeConfig({ skipBinary: true }), logger)).toBeNull();
  });

  it('processes binary files when skipBinary is false', () => {
    mockFs.statSync.mockReturnValue({ size: 5 } as fs.Stats);
    mockFs.readFileSync.mockReturnValue(Buffer.from('hello'));
    const result = createPayloadsFromFile('image.png', makeConfig({ skipBinary: false }), logger);
    expect(result).not.toBeNull();
    expect(result![0]!.isBinary).toBe(true);
    expect(result![0]!.content).toBe(Buffer.from('hello').toString('base64'));
  });

  it('returns null for oversized files when slicing is disabled', () => {
    mockFs.statSync.mockReturnValue({ size: 2000 } as fs.Stats);
    mockFs.readFileSync.mockReturnValue(Buffer.alloc(2000));
    expect(createPayloadsFromFile('big.txt', makeConfig({ maxFileBytes: 1024, sliceLargeFiles: false }), logger)).toBeNull();
  });

  it('slices large files into chunks', () => {
    const content = Buffer.alloc(2500, 'a');
    mockFs.statSync.mockReturnValue({ size: 2500 } as fs.Stats);
    mockFs.readFileSync.mockReturnValue(content);

    const result = createPayloadsFromFile('big.txt', makeConfig({ maxFileBytes: 1024, sliceLargeFiles: true }), logger);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3); // 1024 + 1024 + 452
    expect(result![0]!.isSliced).toBe(true);
    expect(result![0]!.sliceIndex).toBe(1);
    expect(result![0]!.totalSlices).toBe(3);
  });

  it('reads text files as utf8', () => {
    mockFs.statSync.mockReturnValue({ size: 11 } as fs.Stats);
    mockFs.readFileSync.mockReturnValue(Buffer.from('hello world'));
    const result = createPayloadsFromFile('readme.md', makeConfig(), logger);
    expect(result).not.toBeNull();
    expect(result![0]!.content).toBe('hello world');
    expect(result![0]!.isBinary).toBe(false);
    expect(result![0]!.isSliced).toBe(false);
  });

  it('minifies text content when enabled', () => {
    mockFs.statSync.mockReturnValue({ size: 20 } as fs.Stats);
    mockFs.readFileSync.mockReturnValue(Buffer.from('  hello   world  \n\n'));
    const result = createPayloadsFromFile('code.ts', makeConfig({ minify: true }), logger);
    expect(result![0]!.content).toBe('hello world');
  });

  it('returns null and logs warning on read errors', () => {
    mockFs.statSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(createPayloadsFromFile('missing.txt', makeConfig(), logger)).toBeNull();
  });
});
