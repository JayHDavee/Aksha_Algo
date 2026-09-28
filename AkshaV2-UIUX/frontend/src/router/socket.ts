import { io, Socket } from 'socket.io-client';

/**
 * Initialise a Socket.IO client.
 * Connects to the server at the VITE_BASE_URL.
 * Falls back to localhost if not specified.
 */
export const socket: Socket = io(
  import.meta.env.VITE_BASE_URL,
  {
    autoConnect: true,
    transports: ['websocket'], 
  }
);
