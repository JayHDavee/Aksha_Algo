// Package socketio contains WebSocket event handlers.
// Migrated from: src/socketio/watchLiveCameraDetails.js
//
// watch_live_camera.go:
//   WatchLiveCameraDetails() — MongoDB change stream on config collection,
//   emits "liveAllCamera" event on change. Falls back to polling if no replica set.
package socketio

import (
	"context"
	"crypto/md5"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"

	"github.com/algoanalytics-pvt/aksha-backend/internal/db"
	"github.com/algoanalytics-pvt/aksha-backend/internal/functions"
	"github.com/algoanalytics-pvt/aksha-backend/internal/models"
)

// emitLiveCameraUpdate fetches the live camera list and broadcasts it.
func emitLiveCameraUpdate() {
	cameraDetail, err := functions.ListLiveCamera()
	if err != nil {
		log.Printf("WatchLiveCameraDetails: failed to list live cameras: %v", err)
		return
	}

	Emit("liveAllCamera", map[string]interface{}{
		"success": true,
		"message": "Update in camera config collection",
		"info":    cameraDetail,
	})
}

// WatchLiveCameraDetails starts a MongoDB change stream on the config
// collection. When any document changes, it fetches the full live camera
// list and broadcasts a "liveAllCamera" event to all connected clients.
//
// Falls back to polling when change streams aren't available (no replica set).
// Automatically retries if the change stream breaks (matching Node.js
// behaviour where each socket.on("connection") opens a fresh stream).
//
// This function blocks and should be run in a goroutine.
func WatchLiveCameraDetails(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		if !tryChangeStream(ctx) {
			// Change streams not supported — fall back to polling permanently.
			pollLiveCameraChanges(ctx)
			return
		}
		// Change stream broke after initially working — retry after a short pause.
		log.Println("WatchLiveCameraDetails: change stream closed, retrying in 2s...")
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

// tryChangeStream opens a change stream and processes events until it closes.
// Returns false if change streams are not available (no replica set) so the
// caller can fall back to polling. Returns true (with the stream now closed)
// if it worked initially but later broke.
func tryChangeStream(ctx context.Context) bool {
	coll := db.GetCollection(models.ConfigCollection)

	pipeline := mongo.Pipeline{}
	changeStream, err := coll.Watch(ctx, pipeline)
	if err != nil {
		log.Printf("WatchLiveCameraDetails: change stream unavailable: %v", err)
		return false
	}
	defer changeStream.Close(ctx)

	log.Println("WatchLiveCameraDetails: watching config collection for changes")

	for changeStream.Next(ctx) {
		var changeEvent bson.M
		if err := changeStream.Decode(&changeEvent); err != nil {
			log.Printf("WatchLiveCameraDetails: failed to decode change event: %v", err)
			continue
		}

		log.Println("Mongo Camera Collection Changed")
		emitLiveCameraUpdate()
	}

	if err := changeStream.Err(); err != nil {
		log.Printf("WatchLiveCameraDetails: change stream error: %v", err)
	}
	return true // was working, broke — caller should retry
}

// pollLiveCameraChanges periodically checks the config collection for changes
// and emits liveAllCamera updates. Used as a fallback when MongoDB change
// streams are unavailable.
//
// Uses a content hash of all documents to detect ANY change (field updates,
// additions, deletions), not just document count changes.
func pollLiveCameraChanges(ctx context.Context) {
	log.Println("WatchLiveCameraDetails: polling config collection every 5 seconds")
	var lastHash string
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			hash := hashCollection(ctx)
			if hash != "" && hash != lastHash {
				lastHash = hash
				emitLiveCameraUpdate()
			}
		}
	}
}

// hashCollection returns an MD5 hash of all documents in the config collection.
// This detects any field-level changes, not just count changes.
func hashCollection(ctx context.Context) string {
	coll := db.GetCollection(models.ConfigCollection)
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	cursor, err := coll.Find(queryCtx, bson.M{}, options.Find().SetSort(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return ""
	}
	defer cursor.Close(queryCtx)

	var docs []bson.M
	if err := cursor.All(queryCtx, &docs); err != nil {
		return ""
	}

	data, err := json.Marshal(docs)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%x", md5.Sum(data))
}
