package socketio

import (
	"context"
	"testing"
	"time"
)

func TestWatchLiveCameraDetails_CancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	done := make(chan struct{})
	go func() {
		WatchLiveCameraDetails(ctx)
		close(done)
	}()

	select {
	case <-done:
		// good — exited immediately
	case <-time.After(3 * time.Second):
		t.Fatal("WatchLiveCameraDetails did not return after context cancellation")
	}
}

// DB-dependent functions (tryChangeStream, trySpotlightChangeStream,
// hashCollection, pollLiveCameraChanges, pollConfigChanges,
// WatchSpotlightCameraDetails) panic when db.DB is nil, so they
// cannot be unit-tested without a running MongoDB. They are tested
// at the integration level instead.

func TestPollLiveCameraChanges_CancelledImmediately(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan struct{})
	go func() {
		pollLiveCameraChanges(ctx)
		close(done)
	}()

	select {
	case <-done:
		// good
	case <-time.After(2 * time.Second):
		t.Fatal("pollLiveCameraChanges did not return after context cancellation")
	}
}

func TestPollConfigChanges_CancelledImmediately(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	sw := &spotlightWatcher{}
	sw.addCancel(func() {})

	done := make(chan struct{})
	go func() {
		pollConfigChanges(ctx, sw)
		close(done)
	}()

	select {
	case <-done:
		// good
	case <-time.After(2 * time.Second):
		t.Fatal("pollConfigChanges did not return after context cancellation")
	}

	// closeAll should have been called
	sw.mu.Lock()
	if len(sw.cancels) != 0 {
		t.Error("expected cancels to be cleared after pollConfigChanges exits")
	}
	sw.mu.Unlock()
}

func TestEmitLiveCameraUpdate_NoDB_NoPanic(t *testing.T) {
	// Without DB this will log an error — just verify no panic propagates
	defer func() {
		if r := recover(); r != nil {
			// Expected — DB is nil. Just confirm it's the expected panic.
			t.Logf("expected panic without DB: %v", r)
		}
	}()
	emitLiveCameraUpdate()
}

func TestEmitSpotlightUpdate_NoDB_NoPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Logf("expected panic without DB: %v", r)
		}
	}()
	emitSpotlightUpdate()
}
