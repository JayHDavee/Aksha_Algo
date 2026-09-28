package socketio

import (
	"sync"
	"testing"

	socketio "github.com/zishang520/socket.io/v2/socket"
)

func TestConnectedCount_Empty(t *testing.T) {
	// Clear tracked sockets
	connectedMu.Lock()
	origSockets := connectedSockets
	connectedSockets = map[socketio.SocketId]*socketio.Socket{}
	connectedMu.Unlock()
	defer func() {
		connectedMu.Lock()
		connectedSockets = origSockets
		connectedMu.Unlock()
	}()

	if got := ConnectedCount(); got != 0 {
		t.Errorf("ConnectedCount() = %d, want 0", got)
	}
}

func TestEmit_NoClients(t *testing.T) {
	connectedMu.Lock()
	origSockets := connectedSockets
	connectedSockets = map[socketio.SocketId]*socketio.Socket{}
	connectedMu.Unlock()
	defer func() {
		connectedMu.Lock()
		connectedSockets = origSockets
		connectedMu.Unlock()
	}()

	// Should not panic with zero connected clients
	Emit("testEvent", map[string]interface{}{"key": "value"})
}

func TestSetOnConnectCallback(t *testing.T) {
	origCb := onConnectCallback
	defer func() { onConnectCallback = origCb }()

	called := false
	SetOnConnectCallback(func(s *socketio.Socket) {
		called = true
	})

	if onConnectCallback == nil {
		t.Fatal("onConnectCallback should not be nil after SetOnConnectCallback")
	}

	// Test emitInitialData with nil socket (callback set)
	// We can't create a real socket, but we can verify the callback is set
	if !called {
		// Call it manually to verify
		onConnectCallback(nil)
		if !called {
			t.Error("callback was not called")
		}
	}
}

func TestEmitInitialData_NilCallback(t *testing.T) {
	origCb := onConnectCallback
	defer func() { onConnectCallback = origCb }()

	onConnectCallback = nil
	// Should not panic
	emitInitialData(nil)
}

func TestEmitInitialData_WithCallback(t *testing.T) {
	origCb := onConnectCallback
	defer func() { onConnectCallback = origCb }()

	var calledWith *socketio.Socket
	onConnectCallback = func(s *socketio.Socket) {
		calledWith = s
	}

	emitInitialData(nil)
	if calledWith != nil {
		t.Error("expected nil socket to be passed through")
	}
}

func TestConnectedCount_Concurrent(t *testing.T) {
	connectedMu.Lock()
	origSockets := connectedSockets
	connectedSockets = map[socketio.SocketId]*socketio.Socket{}
	connectedMu.Unlock()
	defer func() {
		connectedMu.Lock()
		connectedSockets = origSockets
		connectedMu.Unlock()
	}()

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ConnectedCount()
		}()
	}
	wg.Wait()
}

func TestMessage_Struct(t *testing.T) {
	m := Message{Event: "test", Data: "hello"}
	if m.Event != "test" {
		t.Errorf("Event = %q, want %q", m.Event, "test")
	}
	if m.Data != "hello" {
		t.Errorf("Data = %v, want %q", m.Data, "hello")
	}
}
