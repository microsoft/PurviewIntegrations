/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  moduleNameMapper: {
    // These packages are ESM-only (no CJS export) so Jest's resolver cannot
    // locate them.  Point directly at the lib entry so the mock factory in
    // each test file takes over.
    '^@actions/core$': '<rootDir>/node_modules/@actions/core/lib/core.js',
    '^@actions/github$': '<rootDir>/node_modules/@actions/github/lib/github.js',
    '^@actions/glob$': '<rootDir>/node_modules/@actions/glob/lib/glob.js',
    '^@actions/exec$': '<rootDir>/node_modules/@actions/exec/lib/exec.js',
  },
};
