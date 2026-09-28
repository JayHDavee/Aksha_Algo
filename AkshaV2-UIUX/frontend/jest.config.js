/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',

  // ✅ Use Babel for modern JS/TS/JSX syntax
  transform: {
    '^.+\\.(ts|tsx|js|jsx)$': 'babel-jest',
  },

  // ✅ Ignore all node_modules except modern ESM libraries (like konva)
  transformIgnorePatterns: ['/node_modules/(?!konva|react-konva)'],

  // ✅ Treat TypeScript files as ESM-like for compatibility
  extensionsToTreatAsEsm: ['.ts', '.tsx'],

  // ✅ Map static assets and CSS files to avoid syntax errors in Jest
  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
    '\\.(jpg|jpeg|png|gif|svg)$': '<rootDir>/src/__mocks__/fileMock.js', // <-- Added this line
    '^@/(.*)$': '<rootDir>/src/$1',
  },

  // ✅ Automatically set up global mocks and environment before tests
  setupFilesAfterEnv: ['<rootDir>/src/setupTests.ts'],

  // ✅ Disable ts-jest type diagnostics for faster tests
  globals: {
    'ts-jest': {
      diagnostics: false,
    },
  },
};
