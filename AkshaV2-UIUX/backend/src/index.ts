import "dotenv/config";
import * as path from "path";
import * as http from "http";

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";

import appRoutes from "./appRoutes";
import observer from "../utils/observer";
import watchLiveCameraDetails from "./socketio/watchLiveCameraDetails";
import watchSpotlightCameraDetails from "./socketio/watchSpotlightCamera";

import { Server, Socket } from "socket.io";

// Get port number from environment variables
const PORT: number = Number(process.env.PORT);

// Initialize Express app
export const app = express();

// Enable CORS
app.use(cors());

// Create HTTP server
export const server = http.createServer(app);

// Initialize Socket.IO
export const io = new Server(server, { cors: { origin: "*" } });

// Socket handler
export const handleSocketConnection = async (socket: Socket): Promise<void> => {
  try {
    console.log("New client connected:", socket.id);

    watchLiveCameraDetails(socket);
    watchSpotlightCameraDetails(socket);

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  } catch (error) {
    console.error("Socket connection error:", error);
  }
};

// Register connection handler
io.on("connection", handleSocketConnection);

// Middleware to attach io to request
app.use((req: Request & { io?: Server }, res: Response, next: NextFunction) => {
  req.io = io;
  next();
});

// Application routes
app.use("/", appRoutes);

// Observer
observer();

// Server configuration
server.keepAliveTimeout = 60 * 1000;

// Only start the server if not testing
if (process.env.NODE_ENV !== "test") {
  if (!PORT) {
    console.error("Error: PORT environment variable is not set or invalid.");
    process.exit(1);
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(
      "Aksha path: ",
      process.env.AKSHA_PATH,
      path.join(process.env.AKSHA_PATH || "")
    );
  });
}
