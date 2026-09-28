// Package main is the entry point for the Aksha backend server.
// Migrated from: src/index.js
package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
	"github.com/algoanalytics-pvt/aksha-backend/internal/db"
	"github.com/algoanalytics-pvt/aksha-backend/internal/routes"
	"github.com/algoanalytics-pvt/aksha-backend/internal/socketio"
	"github.com/algoanalytics-pvt/aksha-backend/internal/utils"
)

// corsWrapper wraps any http.Handler to add CORS headers at the raw HTTP level,
// matching Node.js cors() default. This runs BEFORE Gin sees the request.
func corsWrapper(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			origin = "*"
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS, PATCH")
		// Reflect back whatever headers the browser requests (matches Node.js cors() behavior)
		reqHeaders := r.Header.Get("Access-Control-Request-Headers")
		if reqHeaders != "" {
			w.Header().Set("Access-Control-Allow-Headers", reqHeaders)
		} else {
			w.Header().Set("Access-Control-Allow-Headers", "Origin, Content-Length, Content-Type, Authorization, Cookie, Accept, X-Requested-With")
		}
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Length")
		w.Header().Set("Access-Control-Max-Age", "0")
		w.Header().Set("Vary", "Origin")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		h.ServeHTTP(w, r)
	})
}

func main() {
	// Load configuration
	if err := config.Init(); err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Connect to MongoDB
	if err := db.Connect(config.Cfg.Database); err != nil {
		log.Fatalf("Failed to connect to MongoDB: %v", err)
	}

	// Run observer to discover meta_* collections
	utils.Observer()

	// Set up Gin router
	r := gin.Default()

	// Mount all routes
	routes.Setup(r)

	// Start WebSocket watchers
	ctx := context.Background()
	go socketio.WatchLiveCameraDetails(ctx)
	go socketio.WatchSpotlightCameraDetails(ctx)

	// Create a combined handler that routes /socket.io/ directly to the
	// Socket.IO handler (bypassing Gin and CORS wrapper), matching the
	// Node.js architecture where socket.io intercepts before Express.
	// Everything else goes through Gin with the CORS wrapper.
	ginWithCORS := corsWrapper(r)
	combined := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if len(req.URL.Path) >= 10 && req.URL.Path[:10] == "/socket.io" {
			socketio.Handler.ServeHTTP(w, req)
			return
		}
		ginWithCORS.ServeHTTP(w, req)
	})

	server := &http.Server{
		Addr:              ":" + config.Cfg.Port,
		Handler:           combined,
		IdleTimeout:       60 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("Server is running on port %s", config.Cfg.Port)
	log.Printf("Aksha path: %s", config.Cfg.AkshaPath)

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}
