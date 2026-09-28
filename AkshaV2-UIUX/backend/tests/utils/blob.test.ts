import * as fs from 'fs';
import * as path from 'path';
import {
  checkFileExists,
  getFileFromBlob,
  listContainerFiles,
  getFileMetadata,
  validateDateFormat,
} from "../../src/azure/blob";

jest.mock('fs');

describe("azure/blob utils", () => {
  const testDate = "2023-12-25";
  const akshaPath = "/fake/path";

  beforeAll(() => {
    process.env.AKSHA_PATH = akshaPath;
  });

  afterAll(() => {
    delete process.env.AKSHA_PATH;
  });

  describe("checkFileExists", () => {
    it("should return true if file exists", async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      const result = await checkFileExists(testDate);
      expect(result).toBe(true);
    });

    it("should return false if file does not exist", async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      const result = await checkFileExists(testDate);
      expect(result).toBe(false);
    });

    it("should throw error if AKSHA_PATH not set", async () => {
      delete process.env.AKSHA_PATH;
      await expect(checkFileExists(testDate)).rejects.toThrow();
      process.env.AKSHA_PATH = akshaPath;
    });
  });

  describe("getFileFromBlob", () => {
    it("should return file content if file exists", async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('{"data":"test"}');
      const content = await getFileFromBlob(testDate);
      expect(content).toBe('{"data":"test"}');
    });

    it("should throw error if file does not exist", async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      await expect(getFileFromBlob(testDate)).rejects.toThrow();
    });
  });

  describe("listContainerFiles", () => {
    it("should return list of dates", async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([
        "2023-12-24.json",
        "2023-12-25.json",
        "not_a_json.txt",
      ]);
      const files = await listContainerFiles();
      expect(files).toEqual(["2023-12-24", "2023-12-25"]);
    });

    it("should return empty array if directory does not exist", async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      const files = await listContainerFiles();
      expect(files).toEqual([]);
    });
  });

  describe("getFileMetadata", () => {
    it("should return metadata if file exists", async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.statSync as jest.Mock).mockReturnValue({
        size: 1234,
        mtime: new Date("2023-12-25T12:00:00Z"),
      });
      const metadata = await getFileMetadata(testDate);
      expect(metadata.exists).toBe(true);
      expect(metadata.size).toBe(1234);
    });

    it("should return exists false if file does not exist", async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      const metadata = await getFileMetadata(testDate);
      expect(metadata.exists).toBe(false);
    });
  });

  describe("validateDateFormat", () => {
    it("should validate correct date format", () => {
      expect(validateDateFormat("2023-12-25")).toBe(true);
    });

    it("should invalidate incorrect date format", () => {
      expect(validateDateFormat("25-12-2023")).toBe(false);
    });
  });
});
