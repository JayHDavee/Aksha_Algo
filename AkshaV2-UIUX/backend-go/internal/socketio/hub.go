// Package socketio provides a Socket.IO v4 server compatible with socket.io-client v4.
package socketio

import (
	"log"
	"net/http"
	"sync"

	"github.com/zishang520/engine.io/v2/types"
	socketio "github.com/zishang520/socket.io/v2/socket"
)

// Message is kept for compatibility with existing code that references it.
type Message struct {
	Event string      `json:"event"`
	Data  interface{} `json:"data"`
}

// Server is the global Socket.IO server instance.
var Server *socketio.Server

// Handler returns an http.Handler for the Socket.IO server.
var Handler http.Handler

// connectedSockets tracks all live sockets so we can emit to them directly.
// This bypasses Server.Emit() which may not broadcast reliably in all
// versions of the Go socket.io library.
var (
	connectedMu      sync.RWMutex
	connectedSockets = map[socketio.SocketId]*socketio.Socket{}
)

func init() {
	opts := &socketio.ServerOptions{}
	opts.SetCors(&types.Cors{
		Origin:      "*",
		Credentials: true,
	})

	Server = socketio.NewServer(nil, opts)

	Server.On("connection", func(clients ...any) {
		s := clients[0].(*socketio.Socket)
		id := s.Id()
		log.Printf("[Socket.IO] Client connected: %s", id)

		// Track socket
		connectedMu.Lock()
		connectedSockets[id] = s
		connectedMu.Unlock()

		// Handle disconnect on the socket itself (not server-level)
		s.On("disconnect", func(args ...any) {
			log.Printf("[Socket.IO] Client disconnected: %s", id)
			connectedMu.Lock()
			delete(connectedSockets, id)
			connectedMu.Unlock()
		})

		// Emit initial camera list on connect
		go emitInitialData(s)
	})

	Handler = Server.ServeHandler(nil)
}

// onConnectCallback is set by the monitor package to send initial data.
var onConnectCallback func(s *socketio.Socket)

// SetOnConnectCallback registers a callback for new connections.
func SetOnConnectCallback(cb func(s *socketio.Socket)) {
	onConnectCallback = cb
}

func emitInitialData(s *socketio.Socket) {
	if onConnectCallback != nil {
		onConnectCallback(s)
	}
}

// Emit broadcasts an event with data to all connected clients by iterating
// over tracked sockets and emitting to each one directly.
// This is more reliable than Server.Emit() which depends on internal
// namespace broadcast plumbing that can silently drop events.
func Emit(event string, data interface{}) {
	connectedMu.RLock()
	count := len(connectedSockets)
	sockets := make([]*socketio.Socket, 0, count)
	for _, s := range connectedSockets {
		sockets = append(sockets, s)
	}
	connectedMu.RUnlock()

	for _, s := range sockets {
		s.Emit(event, data)
	}
}

// ConnectedCount returns the number of currently connected Socket.IO clients.
func ConnectedCount() int {
	connectedMu.RLock()
	defer connectedMu.RUnlock()
	return len(connectedSockets)
}
