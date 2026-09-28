# Testing Guide for Aksha Frontend

This guide explains how to run and write tests for the Aksha frontend application.

## Setup

The testing environment is already configured with:
- **Jest** as the test runner
- **ts-jest** for TypeScript support
- **@testing-library/jest-dom** for additional DOM assertions
- **jsdom** as the test environment

## Running Tests

### Run all tests
```bash
npm test
```

### Run tests in watch mode
```bash
npm test -- --watch
```

### Run tests with coverage
```bash
npm test -- --coverage
```

### Run specific test file
```bash
npm test -- getDateString.test.ts
```

## Writing Tests

### Test Structure
- Place test files in `__tests__` directories or use `.test.ts` suffix
- Follow the naming convention: `filename.test.ts` or `filename.spec.ts`

### Example Test Structure
```typescript
import { functionToTest } from '../path/to/function';

describe('functionToTest', () => {
  it('should do something specific', () => {
    // Arrange
    const input = 'test input';
    
    // Act
    const result = functionToTest(input);
    
    // Assert
    expect(result).toBe('expected output');
  });
});
```

## Available Test Utilities

### Mock Functions
- `jest.fn()` - Create mock functions
- `jest.spyOn()` - Spy on existing methods
- `jest.mock()` - Mock entire modules

### DOM Testing
- `screen` - Query DOM elements
- `fireEvent` - Trigger DOM events
- `waitFor` - Wait for async operations

## Coverage Reports

After running tests with coverage, check the `coverage/` directory for:
- HTML report: `coverage/lcov-report/index.html`
- LCOV report: `coverage/lcov.info`

## Current Test Files

- `src/utils/__tests__/getDateString.test.ts` - Tests for date string formatting utility
