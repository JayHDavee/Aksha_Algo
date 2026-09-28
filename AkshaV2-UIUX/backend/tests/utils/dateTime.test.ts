import {
  getAllDatesBetween,
  validateDateFormat,
  getDaysBetween,
  formatDate,
  getCurrentDate,
  isDateInRange,
} from "../../utils/dateTime";

describe("dateTime utils", () => {
  describe("getAllDatesBetween", () => {
    it("should generate all dates between two dates inclusive", () => {
      const dates = getAllDatesBetween("2023-12-25", "2023-12-27");
      expect(dates).toEqual(["2023-12-25", "2023-12-26", "2023-12-27"]);
    });

    it("should throw error if start date is after end date", () => {
      expect(() => getAllDatesBetween("2023-12-28", "2023-12-27")).toThrow();
    });

    it("should throw error if invalid dates are provided", () => {
      expect(() => getAllDatesBetween("invalid", "2023-12-27")).toThrow();
    });
  });

  describe("validateDateFormat", () => {
    it("should validate correct date format", () => {
      const result = validateDateFormat("2023-12-25");
      expect(result.isValid).toBe(true);
    });

    it("should invalidate incorrect date format", () => {
      const result = validateDateFormat("25-12-2023");
      expect(result.isValid).toBe(false);
    });
  });

  describe("getDaysBetween", () => {
    it("should return correct number of days between dates", () => {
      const days = getDaysBetween("2023-12-25", "2023-12-28");
      expect(days).toBe(3);
    });

    it("should throw error for invalid dates", () => {
      expect(() => getDaysBetween("invalid", "2023-12-28")).toThrow();
    });
  });

  describe("formatDate", () => {
    it("should format date correctly", () => {
      const formatted = formatDate("2023-12-25", "DD/MM/YYYY");
      expect(formatted).toBe("25/12/2023");
    });

    it("should throw error for invalid date", () => {
      expect(() => formatDate("invalid")).toThrow();
    });
  });

  describe("getCurrentDate", () => {
    it("should return current date in default format", () => {
      const today = getCurrentDate();
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe("isDateInRange", () => {
    it("should return true if date is within range", () => {
      const result = isDateInRange("2023-12-26", "2023-12-25", "2023-12-27");
      expect(result).toBe(true);
    });

    it("should return false if date is outside range", () => {
      const result = isDateInRange("2023-12-28", "2023-12-25", "2023-12-27");
      expect(result).toBe(false);
    });

    it("should return false for invalid dates", () => {
      const result = isDateInRange("invalid", "2023-12-25", "2023-12-27");
      expect(result).toBe(false);
    });
  });
});
