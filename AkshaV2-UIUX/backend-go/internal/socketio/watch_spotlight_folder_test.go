package socketio

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
)

func TestWatchSingleSpotlightFolder_CancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	done := make(chan struct{})
	go func() {
		watchSingleSpotlightFolder(ctx, "nonexistent_cam")
		close(done)
	}()

	select {
	case <-done:
		// good
	case <-time.After(2 * time.Second):
		t.Fatal("watchSingleSpotlightFolder did not return after context cancellation")
	}
}

func TestWatchSingleSpotlightFolder_WaitsForDir(t *testing.T) {
	dir := t.TempDir()
	camName := "delayedcam"

	origPath := config.Cfg.AkshaPath
	config.Cfg.AkshaPath = dir
	defer func() { config.Cfg.AkshaPath = origPath }()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	done := make(chan struct{})
	go func() {
		watchSingleSpotlightFolder(ctx, camName)
		close(done)
	}()

	// Create the directory after a short delay to test the wait loop
	time.Sleep(200 * time.Millisecond)
	spotlightDir := filepath.Join(dir, camName, "spotlight")
	os.MkdirAll(spotlightDir, 0755)

	// Cancel quickly — the watcher will start polling but emitSpotlightUpdate
	// needs DB, so cancel before it detects a file change
	time.Sleep(100 * time.Millisecond)
	cancel()

	select {
	case <-done:
		// good
	case <-time.After(5 * time.Second):
		t.Fatal("watchSingleSpotlightFolder did not exit")
	}
}

func TestWatchSingleSpotlightFolder_ExistingDir_CancelledQuickly(t *testing.T) {
	dir := t.TempDir()
	camName := "existcam"
	spotlightDir := filepath.Join(dir, camName, "spotlight")
	os.MkdirAll(spotlightDir, 0755)

	origPath := config.Cfg.AkshaPath
	config.Cfg.AkshaPath = dir
	defer func() { config.Cfg.AkshaPath = origPath }()

	// Cancel before the 2s poll triggers emitSpotlightUpdate
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	done := make(chan struct{})
	go func() {
		watchSingleSpotlightFolder(ctx, camName)
		close(done)
	}()

	select {
	case <-done:
		// good
	case <-time.After(3 * time.Second):
		t.Fatal("watchSingleSpotlightFolder did not exit after cancel")
	}
}
