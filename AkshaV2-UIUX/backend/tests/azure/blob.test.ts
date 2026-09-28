import * as fs from 'fs';
import * as path from 'path';
import * as azureBlob from '../../src/azure/blob';

jest.mock('fs');

describe('azure/blob.ts', () => {
  const akshaPath = '/mock/path';

  beforeAll(() => {
    process.env.AKSHA_PATH = akshaPath;
  });

  afterAll(() => {
    delete process.env.AKSHA_PATH;
  });

  describe('checkFileExists', () => {
    it('should return true if file exists', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      const result = await azureBlob.checkFileExists('2023-12-25');
      expect(result).toBe(true);
    });

    it('should return false if file does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      const result = await azureBlob.checkFileExists('2023-12-26');
      expect(result).toBe(false);
    });

    it('should throw error if date is invalid', async () => {
      await expect(azureBlob.checkFileExists('')).rejects.toThrow();
    });
  });

  describe('getFileFromBlob', () => {
    it('should return file content if file exists', async () => {
      const fileContent = '{"test": "data"}';
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(fileContent);
      const result = await azureBlob.getFileFromBlob('2023-12-25');
      expect(result).toBe(fileContent);
    });

    it('should throw error if file does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      await expect(azureBlob.getFileFromBlob('2023-12-26')).rejects.toThrow();
    });
  });

  describe('listContainerFiles', () => {
    it('should return list of files', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue(['2023-12-25.json', '2023-12-26.json']);
      const result = await azureBlob.listContainerFiles();
      expect(result).toEqual(['2023-12-25', '2023-12-26']);
    });

    it('should return empty array if directory does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      const result = await azureBlob.listContainerFiles();
      expect(result).toEqual([]);
    });
  });

  describe('getFileMetadata', () => {
    it('should return metadata if file exists', async () => {
      const stats = {
        size: 1234,
        mtime: new Date(),
      };
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.statSync as jest.Mock).mockReturnValue(stats);
      const result = await azureBlob.getFileMetadata('2023-12-25');
      expect(result.exists).toBe(true);
      expect(result.size).toBe(stats.size);
      expect(result.lastModified).toBe(stats.mtime);
    });

    it('should return exists false if file does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      const result = await azureBlob.getFileMetadata('2023-12-26');
      expect(result.exists).toBe(false);
    });
  });

  describe('validateDateFormat', () => {
    it('should validate correct date format', () => {
      expect(azureBlob.validateDateFormat('2023-12-25')).toBe(true);
      expect(azureBlob.validateDateFormat('2023-1-1')).toBe(false);
      expect(azureBlob.validateDateFormat('invalid-date')).toBe(false);
    });
  });
});
