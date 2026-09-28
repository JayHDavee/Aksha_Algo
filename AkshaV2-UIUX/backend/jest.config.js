module.exports = {
  // Use ts-jest to handle TypeScript files
  preset: 'ts-jest', 
  
  // The test environment that will be used. Node.js environment is standard for backends.
  testEnvironment: 'node', 
  
  // A map from regular expressions to paths to transformers (ts-jest for .ts files)
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  
  // Directory where Jest should look for test files
  testMatch: [
    "**/__tests__/**/*.ts",
    "**/?(*.)+(spec|test).ts"
  ],
  
  // If you are using module aliases in tsconfig.json, you may need to map them here
  moduleNameMapper: {
    // Example: '^@src/(.*)$': '<rootDir>/src/$1',
  },
  
  // Jest will look in the "tests" directory specified in package.json
  roots: [
    "<rootDir>/tests"
  ],
};