// watch_spotlight_camera.go
// Migrated from: src/socketio/watchSpotlightCamera.js
//
// WatchSpotlightCameraDetails() — watches spotlight folders on filesystem,
//   emits "spotlightAllCamera" event on file changes.
//   Also watches MongoDB change stream to re-init folder watchers.
package socketio

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
	"github.com/algoanalytics-pvt/aksha-backend/internal/db"
	"github.com/algoanalytics-pvt/aksha-backend/internal/functions"
	"github.com/algoanalytics-pvt/aksha-backend/internal/models"
)

// spotlightWatcher manages filesystem watchers for spotlight folders.
// It tracks active goroutines via cancel functions so they can be stopped
// when the camera list changes.
type spotlightWatcher struct {
	mu       sync.Mutex
	cancels  []context.CancelFunc
}

// closeAll cancels all active folder-watching goroutines.
func (sw *spotlightWatcher) closeAll() {
	sw.mu.Lock()
	defer sw.mu.Unlock()
	for _, cancel := range sw.cancels {
		cancel()
	}
	sw.cancels = nil
}

// addCancel registers a new cancel function for a folder watcher.
func (sw *spotlightWatcher) addCancel(cancel context.CancelFunc) {
	sw.mu.Lock()
	defer sw.mu.Unlock()
	sw.cancels = append(sw.cancels, cancel)
}

// emitSpotlightUpdate fetches the spotlight camera list and broadcasts it.
func emitSpotlightUpdate() {
	cameraDetail, err := functions.ListSpotlightCameras()
	if err != nil {
		log.Printf("watchSpotlightFolder: failed to list spotlight cameras: %v", err)
		return
	}

	Emit("spotlightAllCamera", map[string]interface{}{
		"success": true,
		"message": "Update in spotlight",
		"info":    cameraDetail,
	})
}

// watchSpotlightFolder queries all cameras from the config collection,
// then starts a filesystem watcher goroutine for each camera's spotlight folder.
// It closes any previously active watchers before starting new ones.
func watchSpotlightFolder(ctx context.Context, sw *spotlightWatcher) {
	// Close all existing watchers
	sw.closeAll()

	// Get all cameras
	queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	coll := db.GetCollection(models.ConfigCollection)
	cursor, err := coll.Find(queryCtx, bson.M{})
	if err != nil {
		log.Printf("watchSpotlightFolder: failed to query cameras: %v", err)
		return
	}
	defer cursor.Close(queryCtx)

	var cameras []models.CameraConfig
	if err := cursor.All(queryCtx, &cameras); err != nil {
		log.Printf("watchSpotlightFolder: failed to decode cameras: %v", err)
		return
	}

	// For each camera, watch the spotlight folder
	for _, cam := range cameras {
		cameraName := cam.CameraName
		watchCtx, watchCancel := context.WithCancel(ctx)
		sw.addCancel(watchCancel)

		go watchSingleSpotlightFolder(watchCtx, cameraName)
	}
}

// watchSingleSpotlightFolder polls for the existence of a spotlight folder
// and then watches it for changes using os.Stat-based polling.
// Go's stdlib does not have a built-in cross-platform fs.Watch equivalent
// to Node.js fs.watch, so we use polling with a reasonable interval.
func watchSingleSpotlightFolder(ctx context.Context, cameraName string) {
	spotlightFolder := filepath.Join(config.Cfg.AkshaPath, cameraName, "spotlight")

	// Wait for the spotlight folder to exist (mirrors the Node.js while loop with 5s delay)
	for {
		if _, err := os.Stat(spotlightFolder); err == nil {
			break
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
			// Retry
		}
	}

	log.Printf("watchSpotlightFolder: watching %s", spotlightFolder)

	// Track the last known modification time of the directory
	var lastModTime time.Time
	info, err := os.Stat(spotlightFolder)
	if err == nil {
		lastModTime = info.ModTime()
	}

	// Poll every 2 seconds for changes
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			info, err := os.Stat(spotlightFolder)
			if err != nil {
				continue
			}
			if info.ModTime().After(lastModTime) {
				lastModTime = info.ModTime()
				emitSpotlightUpdate()
			}

			// Also check individual files for changes (workday.jpg, holiday.jpg)
			entries, err := os.ReadDir(spotlightFolder)
			if err != nil {
				continue
			}
			for _, entry := range entries {
				if entry.IsDir() {
					continue
				}
				fi, err := entry.Info()
				if err != nil {
					continue
				}
				if fi.ModTime().After(lastModTime) {
					lastModTime = fi.ModTime()
					emitSpotlightUpdate()
					break
				}
			}
		}
	}
}

// WatchSpotlightCameraDetails starts watching spotlight folders for all cameras
// and also opens a MongoDB change stream on the config collection to re-initialize
// folder watchers whenever the camera list changes.
//
// Automatically retries if the change stream breaks.
// This function blocks and should be run in a goroutine.
func WatchSpotlightCameraDetails(ctx context.Context) {
	sw := &spotlightWatcher{}

	// Start initial file watchers
	watchSpotlightFolder(ctx, sw)

	for {
		if ctx.Err() != nil {
			sw.closeAll()
			return
		}
		if !trySpotlightChangeStream(ctx, sw) {
			// Change streams not supported — fall back to polling permanently.
			pollConfigChanges(ctx, sw)
			sw.closeAll()
			return
		}
		// Change stream broke — retry after a short pause.
		log.Println("WatchSpotlightCameraDetails: change stream closed, retrying in 2s...")
		select {
		case <-ctx.Done():
			sw.closeAll()
			return
		case <-time.After(2 * time.Second):
		}
	}
}

// trySpotlightChangeStream opens a change stream and reinitializes spotlight
// watchers on every config change. Returns false if change streams aren't
// available, true if it worked but later broke.
func trySpotlightChangeStream(ctx context.Context, sw *spotlightWatcher) bool {
	coll := db.GetCollection(models.ConfigCollection)
	pipeline := mongo.Pipeline{}
	changeStream, err := coll.Watch(ctx, pipeline)
	if err != nil {
		log.Printf("WatchSpotlightCameraDetails: change stream unavailable: %v", err)
		return false
	}
	defer changeStream.Close(ctx)

	log.Println("WatchSpotlightCameraDetails: watching config collection for changes")

	for changeStream.Next(ctx) {
		var changeEvent bson.M
		if err := changeStream.Decode(&changeEvent); err != nil {
			log.Printf("WatchSpotlightCameraDetails: failed to decode change event: %v", err)
			continue
		}
		watchSpotlightFolder(ctx, sw)
	}

	if err := changeStream.Err(); err != nil {
		log.Printf("WatchSpotlightCameraDetails: change stream error: %v", err)
	}
	return true
}

// pollConfigChanges periodically checks the config collection for camera count
// changes and re-initializes spotlight watchers. Used as a fallback when
// MongoDB change streams are unavailable (no replica set).
func pollConfigChanges(ctx context.Context, sw *spotlightWatcher) {
	var lastCount int64
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			sw.closeAll()
			return
		case <-ticker.C:
			coll := db.GetCollection(models.ConfigCollection)
			queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			count, err := coll.CountDocuments(queryCtx, bson.M{})
			cancel()
			if err != nil {
				continue
			}
			if count != lastCount {
				lastCount = count
				watchSpotlightFolder(ctx, sw)
			}
		}
	}
}
