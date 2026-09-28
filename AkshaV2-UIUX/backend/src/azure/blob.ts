import * as fs from 'fs';
import * as path from 'path';

/**
 * Azure Blob Storage Utility Module
 * 
 * This module provides utility functions for interacting with Azure Blob Storage
 * and local file system operations for insight report data. Currently implemented
 * as a local file system interface with Azure Blob Storage integration planned.
 * 
 * The module handles:
 * - File existence checking for insight reports
 * - File retrieval from local storage (with Azure Blob fallback)
 * - Container file listing operations
 * - Date-based file organization for insight reports
 * 
 * Environment Variables Required:
 * - AKSHA_PATH: Base path for local file storage
 * 
 * File Structure:
 * - Insight reports are stored as: {AKSHA_PATH}/insight_report/{date}.json
 * - Date format: YYYY-MM-DD (e.g., 2023-12-25.json)
 */

/**
 * Interface for blob storage configuration
 */
interface IBlobConfig {
  containerName?: string;
  connectionString?: string;
  accountName?: string;
}

/**
 * Interface for file metadata
 */
interface IFileMetadata {
  exists: boolean;
  size?: number;
  lastModified?: Date;
  path: string;
}

/**
 * Check if an insight report file exists in the storage system
 * 
 * This function checks for the existence of insight report files based on date.
 * Currently implemented as local file system check, with Azure Blob Storage
 * integration available for future enhancement.
 * 
 * @param {string} date - Date string in YYYY-MM-DD format
 * @returns {Promise<boolean>} Promise resolving to true if file exists, false otherwise
 * 
 * @example
 * const exists = await checkFileExists('2023-12-25');
 * if (exists) {
 *   console.log('Insight report for Christmas 2023 exists');
 * }
 * 
 * @throws {Error} If AKSHA_PATH environment variable is not set
 * @throws {Error} If file system access fails
 */
export const checkFileExists = async (date: string): Promise<boolean> => {
  try {
    // Validate input parameters
    if (!date || typeof date !== 'string') {
      throw new Error('Date parameter is required and must be a string');
    }

    // Validate environment configuration
    const akshaPath = process.env.AKSHA_PATH;
    if (!akshaPath) {
      throw new Error('AKSHA_PATH environment variable is not configured');
    }

    // Construct file path for insight report
    const filePath = path.join(akshaPath, 'insight_report', `${date}.json`);
    
    // Check file existence using synchronous method for reliability
    const fileExists = fs.existsSync(filePath);
    
    // Log file check for debugging purposes
    console.log(`File existence check for ${date}: ${fileExists ? 'EXISTS' : 'NOT FOUND'}`);
    
    return fileExists;
  } catch (error: any) {
    console.error(`Error checking file existence for date ${date}:`, error.message);
    throw new Error(`Failed to check file existence: ${error.message}`);
  }
};

/**
 * Retrieve insight report file content from storage
 * 
 * This function reads insight report data from the local file system.
 * The data is returned as a UTF-8 encoded string containing JSON data
 * for the specified date.
 * 
 * @param {string} date - Date string in YYYY-MM-DD format
 * @returns {Promise<string>} Promise resolving to file content as string
 * 
 * @example
 * try {
 *   const reportData = await getFileFromBlob('2023-12-25');
 *   const parsedData = JSON.parse(reportData);
 *   console.log('Camera alerts:', parsedData.cameras);
 * } catch (error) {
 *   console.error('Failed to load report:', error);
 * }
 * 
 * @throws {Error} If file does not exist
 * @throws {Error} If file cannot be read
 * @throws {Error} If AKSHA_PATH is not configured
 */
export const getFileFromBlob = async (date: string): Promise<string> => {
  try {
    // Validate input parameters
    if (!date || typeof date !== 'string') {
      throw new Error('Date parameter is required and must be a string');
    }

    // Validate environment configuration
    const akshaPath = process.env.AKSHA_PATH;
    if (!akshaPath) {
      throw new Error('AKSHA_PATH environment variable is not configured');
    }

    // Construct file path for insight report
    const filePath = path.join(akshaPath, 'insight_report', `${date}.json`);
    
    // Check if file exists before attempting to read
    if (!fs.existsSync(filePath)) {
      throw new Error(`Insight report file not found for date: ${date}`);
    }

    // Read file content with UTF-8 encoding
    const fileData = fs.readFileSync(filePath, 'utf-8');
    
    // Validate that file content is not empty
    if (!fileData || fileData.trim().length === 0) {
      throw new Error(`Insight report file is empty for date: ${date}`);
    }

    // Log successful file retrieval
    console.log(`Successfully retrieved insight report for ${date} (${fileData.length} characters)`);

    return fileData;
  } catch (error: any) {
    console.error(`Error retrieving file for date ${date}:`, error.message);
    throw new Error(`Failed to retrieve file: ${error.message}`);
  }
};

/**
 * List all insight report files in the storage container
 * 
 * This function lists all available insight report files in the local storage.
 * Currently implemented for local file system, with Azure Blob Storage
 * container listing planned for future implementation.
 * 
 * @returns {Promise<string[]>} Promise resolving to array of available dates
 * 
 * @example
 * const availableDates = await listContainerFiles();
 * console.log('Available insight reports:', availableDates);
 * // Output: ['2023-12-24', '2023-12-25', '2023-12-26']
 * 
 * @throws {Error} If directory cannot be accessed
 * @throws {Error} If AKSHA_PATH is not configured
 */
export const listContainerFiles = async (): Promise<string[]> => {
  try {
    // Validate environment configuration
    const akshaPath = process.env.AKSHA_PATH;
    if (!akshaPath) {
      throw new Error('AKSHA_PATH environment variable is not configured');
    }

    // Construct directory path for insight reports
    const reportsDir = path.join(akshaPath, 'insight_report');
    
    // Check if reports directory exists
    if (!fs.existsSync(reportsDir)) {
      console.warn(`Insight reports directory does not exist: ${reportsDir}`);
      return [];
    }

    // Read directory contents
    const files = fs.readdirSync(reportsDir);
    
    // Filter for JSON files and extract dates
    const availableDates = files
      .filter(file => file.endsWith('.json'))
      .map(file => file.replace('.json', ''))
      .sort(); // Sort dates chronologically

    console.log(`Found ${availableDates.length} insight report files in storage`);
    
    // Log available files for debugging
    availableDates.forEach(date => {
      console.log(`\tInsight Report: ${date}.json`);
    });

    return availableDates;
  } catch (error: any) {
    console.error('Error listing container files:', error.message);
    throw new Error(`Failed to list files: ${error.message}`);
  }
};

/**
 * Get file metadata for an insight report
 * 
 * This utility function provides detailed metadata about an insight report file
 * including existence, size, and modification date.
 * 
 * @param {string} date - Date string in YYYY-MM-DD format
 * @returns {Promise<IFileMetadata>} Promise resolving to file metadata object
 * 
 * @example
 * const metadata = await getFileMetadata('2023-12-25');
 * console.log(`File size: ${metadata.size} bytes`);
 * console.log(`Last modified: ${metadata.lastModified}`);
 */
export const getFileMetadata = async (date: string): Promise<IFileMetadata> => {
  try {
    const akshaPath = process.env.AKSHA_PATH;
    if (!akshaPath) {
      throw new Error('AKSHA_PATH environment variable is not configured');
    }

    const filePath = path.join(akshaPath, 'insight_report', `${date}.json`);
    
    if (!fs.existsSync(filePath)) {
      return {
        exists: false,
        path: filePath
      };
    }

    const stats = fs.statSync(filePath);
    
    return {
      exists: true,
      size: stats.size,
      lastModified: stats.mtime,
      path: filePath
    };
  } catch (error: any) {
    console.error(`Error getting file metadata for ${date}:`, error.message);
    throw new Error(`Failed to get file metadata: ${error.message}`);
  }
};

/**
 * Validate date format for insight reports
 * 
 * @param {string} date - Date string to validate
 * @returns {boolean} True if date format is valid (YYYY-MM-DD)
 */
export const validateDateFormat = (date: string): boolean => {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  return dateRegex.test(date);
};
