/**
 * @file getDateString.test.ts
 * @description Jest tests for the getDateString utility function
 * Tests various input formats and edge cases for date string formatting
 */

import getDateString from '../../utils/getDateString';

describe('getDateString', () => {
  describe('Valid date string inputs', () => {
    it('should format ISO date string correctly', () => {
      const input = '2023-06-07T10:30:00.000Z';
      const result = getDateString(input);
      expect(result).toBe('2023-06-07');
    });

    it('should format date string with timezone correctly', () => {
      const input = 'Wed Jun 07 2023 16:21:14 GMT+0530';
      const result = getDateString(input);
      expect(result).toBe('2023-06-07');
    });

    it('should format simple date string correctly', () => {
      const input = '2023-12-25';
      const result = getDateString(input);
      expect(result).toBe('2023-12-25');
    });

    it('should format date with time string correctly', () => {
      const input = '2023-12-25 14:30:00';
      const result = getDateString(input);
      expect(result).toBe('2023-12-25');
    });
  });

  describe('Date object inputs', () => {
    it('should format Date object correctly', () => {
      const input = new Date('2023-06-07');
      const result = getDateString(input);
      expect(result).toBe('2023-06-07');
    });

    it('should format Date object with time correctly', () => {
      const input = new Date('2023-06-07T15:30:45');
      const result = getDateString(input);
      expect(result).toBe('2023-06-07');
    });

    it('should handle current date correctly', () => {
      const today = new Date();
      const expected = today.toISOString().split('T')[0];
      const result = getDateString(today);
      expect(result).toBe(expected);
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle single digit months correctly', () => {
      const input = '2023-01-05';
      const result = getDateString(input);
      expect(result).toBe('2023-01-05');
    });

    it('should handle single digit days correctly', () => {
      const input = '2023-12-05';
      const result = getDateString(input);
      expect(result).toBe('2023-12-05');
    });

    it('should handle leap year dates correctly', () => {
      const input = '2024-02-29';
      const result = getDateString(input);
      expect(result).toBe('2024-02-29');
    });

    it('should handle end of year dates correctly', () => {
      const input = '2023-12-31';
      const result = getDateString(input);
      expect(result).toBe('2023-12-31');
    });

    it('should handle beginning of year dates correctly', () => {
      const input = '2023-01-01';
      const result = getDateString(input);
      expect(result).toBe('2023-01-01');
    });
  });

  describe('Invalid inputs', () => {
    it('should handle invalid date string gracefully', () => {
      const input = 'invalid-date';
      const result = getDateString(input);
      expect(result).toBe('');
    });

    it('should handle empty string gracefully', () => {
      const input = '';
      const result = getDateString(input);
      expect(result).toBe('');
    });
  });

  describe('Different year formats', () => {
    it('should handle year 2000 correctly', () => {
      const input = '2000-01-01';
      const result = getDateString(input);
      expect(result).toBe('2000-01-01');
    });

    it('should handle future dates correctly', () => {
      const input = '2050-12-31';
      const result = getDateString(input);
      expect(result).toBe('2050-12-31');
    });

    it('should handle past dates correctly', () => {
      const input = '1990-06-15';
      const result = getDateString(input);
      expect(result).toBe('1990-06-15');
    });
  });

  describe('Time zone considerations', () => {
    it('should handle UTC dates correctly', () => {
      const input = new Date('2023-06-07T00:00:00Z');
      const result = getDateString(input);
      expect(result).toBe('2023-06-07');
    });

    it('should handle local timezone dates correctly', () => {
      const input = new Date('2023-06-07T00:00:00');
      const result = getDateString(input);
      expect(result).toBe('2023-06-07');
    });
  });
});
