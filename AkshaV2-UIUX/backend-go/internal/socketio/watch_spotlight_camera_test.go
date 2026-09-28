package socketio

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestSpotlightWatcher_CloseAll(t *testing.T) {
	sw := &spotlightWatcher{}

	var cancelled int32
	for i := 0; i < 5; i++ {
		_, cancel := context.WithCancel(context.Background())
		wrappedCancel := func() {
			atomic.AddInt32(&cancelled, 1)
			cancel()
		}
		sw.addCancel(wrappedCancel)
	}

	sw.closeAll()

	if got := atomic.LoadInt32(&cancelled); got != 5 {
		t.Errorf("closeAll cancelled %d contexts, want 5", got)
	}

	// After closeAll, cancels slice should be empty
	sw.mu.Lock()
	if len(sw.cancels) != 0 {
		t.Errorf("cancels slice length = %d after closeAll, want 0", len(sw.cancels))
	}
	sw.mu.Unlock()
}

func TestSpotlightWatcher_AddCancel(t *testing.T) {
	sw := &spotlightWatcher{}

	for i := 0; i < 3; i++ {
		sw.addCancel(func() {})
	}

	sw.mu.Lock()
	if len(sw.cancels) != 3 {
		t.Errorf("cancels count = %d, want 3", len(sw.cancels))
	}
	sw.mu.Unlock()
}

func TestSpotlightWatcher_CloseAllThenAdd(t *testing.T) {
	sw := &spotlightWatcher{}

	sw.addCancel(func() {})
	sw.addCancel(func() {})
	sw.closeAll()

	// Should be able to add new cancels after closeAll
	sw.addCancel(func() {})
	sw.mu.Lock()
	if len(sw.cancels) != 1 {
		t.Errorf("cancels count = %d after closeAll+add, want 1", len(sw.cancels))
	}
	sw.mu.Unlock()
}

func TestSpotlightWatcher_ConcurrentAccess(t *testing.T) {
	sw := &spotlightWatcher{}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	// Concurrent adds
	done := make(chan struct{})
	go func() {
		for i := 0; i < 100; i++ {
			sw.addCancel(func() {})
		}
		done <- struct{}{}
	}()

	// Concurrent closeAll
	go func() {
		for {
			select {
			case <-ctx.Done():
				done <- struct{}{}
				return
			default:
				sw.closeAll()
				time.Sleep(time.Millisecond)
			}
		}
	}()

	<-done
	<-done
	// No race condition = pass
}
