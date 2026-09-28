/**
 * @file getTabsDateString.test.ts
 * @description Jest tests for the getTabsDateString utility function
 * Tests various input formats and edge cases for date string formatting in 'dd/MM/yy' format
 */

import getTabsDateString from '../../utils/getTabsDateString';

describe('getTabsDateString', () => {
  describe('Valid date string inputs', () => {
    it('should format ISO date string correctly', () => {
      const input = '2024-06-01';
      const result = getTabsDateString(input);
      expect(result).toBe('01/06/24');
    });

    it('should format date string with timezone correctly', () => {
      const input = 'Wed Jun 01 2024 16:21:14 GMT+0530';
      const result = getTabsDateString(input);
      expect(result).toBe('01/06/24');
    });

    it('should format date with time string correctly', () => {
      const input = '2024-12-25 14:30:00';
      const result = getTabsDateString(input);
      expect(result).toBe('25/12/24');
    });
  });

  describe('Date object inputs', () => {
    it('should format Date object correctly', () => {
      const input = new Date('2024-06-01');
      const result = getTabsDateString(input);
      expect(result).toBe('01/06/24');
    });

    it('should format Date object with time correctly', () => {
      const input = new Date('2024-06-01T15:30:45');
      const result = getTabsDateString(input);
      expect(result).toBe('01/06/24');
    });

    it('should handle current date correctly', () => {
      const today = new Date();
      const expected = today.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit'
      }).replace(/\//g, '/');
      const result = getTabsDateString(today);
      expect(result).toBe(expected);
    });
  });

  describe('Timestamp inputs', () => {
    it('should format Unix timestamp correctly', () => {
      const input = 1717200000000; // 2024-06-01 00:00:00 UTC
      const result = getTabsDateString(input);
      expect(result).toBe('01/06/24');
    });

    it('should format string timestamp correctly', () => {
      const input = '1717200000000';
      const result = getTabsDateString(input);
      expect(result).toBe('01/06/24');
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle single digit months correctly', () => {
      const input = '2024-01-05';
      const result = getTabsDateString(input);
      expect(result).toBe('05/01/24');
    });

    it('should handle single digit days correctly', () => {
      const input = '2024-12-05';
      const result = getTabsDateString(input);
      expect(result).toBe('05/12/24');
    });

    it('should handle leap year dates correctly', () => {
      const input = '2024-02-29';
      const result = getTabsDateString(input);
      expect(result).toBe('29/02/24');
    });

    it('should handle end of year dates correctly', () => {
      const input = '2024-12-31';
      const result = getTabsDateString(input);
      expect(result).toBe('31/12/24');
    });

    it('should handle beginning of year dates correctly', () => {
      const input = '2024-01-01';
      const result = getTabsDateString(input);
      expect(result).toBe('01/01/24');
    });
  });

  describe('Different year formats', () => {
    it('should handle year 2000 correctly', () => {
      const input = '2000-01-01';
      const result = getTabsDateString(input);
      expect(result).toBe('01/01/00');
    });

    it('should handle future dates correctly', () => {
      const input = '2050-12-31';
      const result = getTabsDateString(input);
      expect(result).toBe('31/12/50');
    });

    it('should handle past dates correctly', () => {
      const input = '1990-06-15';
      const result = getTabsDateString(input);
      expect(result).toBe('15/06/90');
    });
  });

  describe('Time zone considerations', () => {
    it('should handle UTC dates correctly', () => {
      const input = new Date('2024-06-01T00:00:00Z');
      const result = getTabsDateString(input);
      expect(result).toBe('01/06/24');
    });

    it('should handle local timezone dates correctly', () => {
      const input = new Date('2024-06-01T00:00:00');
      const result = getTabsDateString(input);
      expect(result).toBe('01/06/24');
    });
  });

  describe('Invalid inputs', () => {
    it('should handle empty string gracefully', () => {
      const input = '';
      const result = getTabsDateString(input);
      expect(result).toBe('01/01/70'); // Epoch date
    });

    it('should handle invalid date string gracefully', () => {
      // JavaScript's Date constructor is forgiving, this will return epoch date
      const input = 'invalid-date';
      const result = getTabsDateString(input);
      expect(result).toBe('01/01/70'); // Epoch date
    });
  });
});
