import * as path from 'path';
import * as fs from 'fs';
import watch from "node-watch";
import config from "../src/models/configSchema";
import mongoose, { Schema, Model, Document } from "mongoose";
import moment from 'moment';

/**
 * Database Observer and Metadata Management Module
 * 
 * This module provides functionality for observing and managing camera metadata
 * collections in the Aksha surveillance system. It includes:
 * - Dynamic discovery of metadata collections
 * - Real-time monitoring of camera data changes
 * - Metadata aggregation and processing
 * - Collection schema management for dynamic camera data
 * 
 * The observer pattern is used to monitor database changes and maintain
 * up-to-date metadata for all active cameras in the surveillance system.
 */

// Initialize debug logger for observer operations
const debug = require("debug")("author");

/**
 * Interface for camera metadata structure
 */
interface ICameraMetadata {
  _id: string;
  Timestamp: Date | string;
  Results?: any;
  Frame_Anomaly?: boolean | number;
  Object_Anomaly?: boolean | number;
  camera_name: string;
}

/**
 * Interface for metadata collection information
 */
interface IMetaCollection {
  name: string;
  model?: Model<any>;
  lastUpdate?: Date;
}

/**
 * Interface for observer configuration
 */
interface IObserverConfig {
  clientOrigin?: string;
  enableFileWatching?: boolean;
  metadataRefreshInterval?: number;
}

/**
 * Interface for collection listing result
 */
interface ICollectionInfo {
  name: string;
  type?: string;
  options?: any;
}

/**
 * Global array to store metadata from all cameras
 */
let metaCameras: ICameraMetadata[] = [];

/**
 * Environment configuration
 */
const clientOrigin: string = process.env.CLIENT_ORIGIN || "http://localhost:3000";

/**
 * Initialize the database observer for camera metadata collections
 * 
 * This function sets up monitoring for all metadata collections in the database.
 * It dynamically discovers collections with the "meta_" prefix and creates
 * appropriate Mongoose models for each camera's metadata.
 * 
 * The observer:
 * - Discovers all metadata collections automatically
 * - Creates dynamic schemas for flexible metadata storage
 * - Retrieves the latest metadata entry for each camera
 * - Maintains a global cache of camera metadata
 * 
 * @param {IObserverConfig} config - Optional configuration for the observer
 * @returns {Promise<void>} Promise that resolves when observer is initialized
 * 
 * @example
 * // Initialize observer with default settings
 * await observer();
 * 
 * // Initialize with custom configuration
 * await observer({
 *   clientOrigin: 'https://surveillance.example.com',
 *   enableFileWatching: true,
 *   metadataRefreshInterval: 5000
 * });
 */
const observer = async (config?: IObserverConfig): Promise<void> => {
  try {
    console.log('🔍 Initializing database observer for camera metadata...');

    // Clear existing metadata cache
    metaCameras = [];

    // Wait for database connection to be established
    await waitForDatabaseConnection();

    // Set up database connection event handlers
    mongoose.connection.on("open", async function (ref: any): Promise<void> {
      try {
        console.log('📊 Database connection established, discovering metadata collections...');

        // Discover all collections in the database
        const collections = await discoverMetadataCollections();
        
        if (collections.length === 0) {
          console.warn('⚠️ No metadata collections found with "meta_" prefix');
          return;
        }

        console.log(`📋 Found ${collections.length} metadata collections`);

        // Process each metadata collection
        await processMetadataCollections(collections);

        console.log(`✅ Observer initialized successfully with ${metaCameras.length} camera metadata entries`);

        // Set up periodic refresh if configured
        if (config?.metadataRefreshInterval) {
          setInterval(async () => {
            await refreshMetadata();
          }, config.metadataRefreshInterval);
        }

      } catch (error: any) {
        console.error('❌ Error in database connection handler:', error.message);
        throw error;
      }
    });

    // Handle database connection errors
    mongoose.connection.on("error", function (error: any): void {
      console.error('❌ Database connection error in observer:', error);
    });

    mongoose.connection.on("disconnected", function (): void {
      console.warn('⚠️ Database disconnected, observer may not function properly');
    });

  } catch (error: any) {
    console.error('❌ Failed to initialize database observer:', error.message);
    throw new Error(`Observer initialization failed: ${error.message}`);
  }
};

/**
 * Wait for database connection to be established
 * 
 * @returns {Promise<void>} Promise that resolves when connection is ready
 */
const waitForDatabaseConnection = async (): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (mongoose.connection.readyState === 1) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error('Database connection timeout'));
    }, 30000); // 30 second timeout

    mongoose.connection.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });

    mongoose.connection.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
};

/**
 * Discover all metadata collections in the database
 * 
 * @returns {Promise<ICollectionInfo[]>} Array of metadata collection information
 */
const discoverMetadataCollections = async (): Promise<ICollectionInfo[]> => {
  try {
    const collections = await mongoose.connection.db.listCollections().toArray();
    
    // Filter collections that contain metadata (prefix "meta_")
    const metadataCollections = collections.filter((collection: any) => {
      return collection.name.toLowerCase().includes("meta_");
    });

    debug(`Discovered ${metadataCollections.length} metadata collections`);
    
    return metadataCollections.map((collection: any) => ({
      name: collection.name,
      type: collection.type,
      options: collection.options
    }));

  } catch (error: any) {
    console.error('Error discovering metadata collections:', error.message);
    throw new Error(`Failed to discover collections: ${error.message}`);
  }
};

/**
 * Process metadata collections and extract latest data
 * 
 * @param {ICollectionInfo[]} collections - Array of collection information
 * @returns {Promise<void>} Promise that resolves when processing is complete
 */
const processMetadataCollections = async (collections: ICollectionInfo[]): Promise<void> => {
  try {
    for (const collection of collections) {
      await processSingleMetadataCollection(collection);
    }
  } catch (error: any) {
    console.error('Error processing metadata collections:', error.message);
    throw error;
  }
};

/**
 * Process a single metadata collection
 * 
 * @param {ICollectionInfo} collection - Collection information
 * @returns {Promise<void>} Promise that resolves when processing is complete
 */
const processSingleMetadataCollection = async (collection: ICollectionInfo): Promise<void> => {
  try {
    // Extract camera name from collection name (format: meta_cameraname)
    const cameraName = collection.name.split("_")[1];
    
    if (!cameraName) {
      console.warn(`⚠️ Invalid collection name format: ${collection.name}`);
      return;
    }

    // Create dynamic schema for flexible metadata storage
    const metaSchema = new Schema({}, { 
      collection: collection.name, 
      strict: false,
      timestamps: false
    });

    // Create or retrieve model for this collection
    let metaModel: Model<any>;
    try {
      metaModel = mongoose.model(collection.name);
    } catch {
      metaModel = mongoose.model(collection.name, metaSchema);
    }

    // Retrieve the latest metadata entry for this camera
    const latestMetadata = await metaModel
      .findOne()
      .sort({ Timestamp: -1 })
      .lean()
      .exec();

    if (latestMetadata) {
      // Add to global metadata cache
      const cameraMetadata: ICameraMetadata = {
        _id: latestMetadata._id?.toString() || '',
        Timestamp: latestMetadata.Timestamp,
        Results: latestMetadata.Results,
        Frame_Anomaly: latestMetadata.Frame_Anomaly,
        Object_Anomaly: latestMetadata.Object_Anomaly,
        camera_name: cameraName,
      };

      metaCameras.push(cameraMetadata);
      
      debug(`Processed metadata for camera: ${cameraName}`);
    } else {
      console.warn(`⚠️ No metadata found for camera: ${cameraName}`);
    }

  } catch (error: any) {
    console.error(`Error processing collection ${collection.name}:`, error.message);
    // Continue processing other collections even if one fails
  }
};

/**
 * Refresh metadata cache by re-processing all collections
 * 
 * @returns {Promise<void>} Promise that resolves when refresh is complete
 */
const refreshMetadata = async (): Promise<void> => {
  try {
    debug('Refreshing metadata cache...');
    
    const collections = await discoverMetadataCollections();
    metaCameras = []; // Clear existing cache
    
    await processMetadataCollections(collections);
    
    debug(`Metadata cache refreshed with ${metaCameras.length} entries`);
  } catch (error: any) {
    console.error('Error refreshing metadata:', error.message);
  }
};

/**
 * Get current metadata for all cameras
 * 
 * @returns {ICameraMetadata[]} Array of camera metadata
 * 
 * @example
 * const metadata = getMetaCameras();
 * metadata.forEach(camera => {
 *   console.log(`Camera: ${camera.camera_name}, Last Update: ${camera.Timestamp}`);
 * });
 */
export const getMetaCameras = (): ICameraMetadata[] => {
  return [...metaCameras]; // Return a copy to prevent external modification
};

/**
 * Get metadata for a specific camera
 * 
 * @param {string} cameraName - Name of the camera
 * @returns {ICameraMetadata | undefined} Camera metadata or undefined if not found
 * 
 * @example
 * const cameraData = getMetaCameraByName('camera1');
 * if (cameraData) {
 *   console.log(`Latest anomaly status: ${cameraData.Frame_Anomaly}`);
 * }
 */
export const getMetaCameraByName = (cameraName: string): ICameraMetadata | undefined => {
  return metaCameras.find(camera => camera.camera_name === cameraName);
};

/**
 * Get count of active cameras with metadata
 * 
 * @returns {number} Number of cameras with metadata
 */
export const getActiveCameraCount = (): number => {
  return metaCameras.length;
};

/**
 * Check if observer has been initialized
 * 
 * @returns {boolean} True if observer is initialized
 */
export const isObserverInitialized = (): boolean => {
  return metaCameras.length > 0;
};

/**
 * Get cameras with recent anomalies
 * 
 * @param {number} timeThresholdMinutes - Time threshold in minutes (default: 30)
 * @returns {ICameraMetadata[]} Array of cameras with recent anomalies
 */
export const getCamerasWithRecentAnomalies = (timeThresholdMinutes: number = 30): ICameraMetadata[] => {
  const threshold = moment().subtract(timeThresholdMinutes, 'minutes');
  
  return metaCameras.filter(camera => {
    const hasAnomaly = camera.Frame_Anomaly || camera.Object_Anomaly;
    const isRecent = moment(camera.Timestamp).isAfter(threshold);
    return hasAnomaly && isRecent;
  });
};

export default observer;
