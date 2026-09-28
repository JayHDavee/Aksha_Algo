import mongoose from "mongoose";

/**
 * Database Connection Module
 * 
 * This module establishes and manages the MongoDB database connection
 * for the Aksha surveillance system. It handles:
 * - Connection establishment using environment variables
 * - Connection success and failure logging
 * - Graceful error handling for database connectivity issues
 * 
 * The connection is automatically established when this module is imported,
 * making the database available throughout the application.
 * 
 * Environment Variables Required:
 * - DATABASE: MongoDB connection string (e.g., mongodb://localhost:27017/aksha)
 * 
 * @example
 * // Import this module to establish database connection
 * import './db/connection';
 * 
 * // The connection will be automatically established
 * // and available for use with Mongoose models
 */

// Initialize debug logger for database operations
const debug = require("debug")("author");

/**
 * MongoDB connection string from environment variables
 * Falls back to a default local connection if not specified
 */
const DATABASE: string = process.env.DATABASE || "mongodb://localhost:27017/aksha";

/**
 * Establish MongoDB connection with error handling
 * 
 * This connection setup:
 * - Uses the DATABASE environment variable for connection string
 * - Logs successful connections for monitoring
 * - Handles connection failures gracefully with error logging
 * - Maintains persistent connection for the application lifecycle
 */
mongoose
  .connect(DATABASE)
  .then((): void => {
    debug("MongoDB connection successful");
    console.log(`Connected to MongoDB: ${DATABASE}`);
  })
  .catch((error: Error): void => {
    debug("MongoDB connection failed:", error.message);
    console.error(`Failed to connect to MongoDB: ${error.message}`);
    
    // Log additional connection details for debugging
    console.error("Connection string:", DATABASE);
    console.error("Full error:", error);
    
    // Exit process on connection failure to prevent running without database
    process.exit(1);
  });

/**
 * Handle connection events for monitoring and debugging
 */
mongoose.connection.on('connected', (): void => {
  debug('Mongoose connected to MongoDB');
});

mongoose.connection.on('error', (error: Error): void => {
  debug('Mongoose connection error:', error);
  console.error('MongoDB connection error:', error);
});

mongoose.connection.on('disconnected', (): void => {
  debug('Mongoose disconnected from MongoDB');
  console.warn(' MongoDB disconnected');
});

/**
 * Graceful shutdown handling
 * Ensures database connections are properly closed when the application terminates
 */
process.on('SIGINT', async (): Promise<void> => {
  try {
    await mongoose.connection.close();
    debug('MongoDB connection closed through app termination');
    console.log(' MongoDB connection closed gracefully');
    process.exit(0);
  } catch (error) {
    console.error('Error closing MongoDB connection:', error);
    process.exit(1);
  }
});

// Export the mongoose connection for use in other modules if needed
export default mongoose.connection;
