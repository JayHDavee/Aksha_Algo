// Package routes sets up all Gin route groups.
// Migrated from: src/appRoutes.js
package routes

import (
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
	"github.com/algoanalytics-pvt/aksha-backend/internal/middleware"
)

// Setup configures all route groups on the given Gin engine.
func Setup(r *gin.Engine) {
	api := r.Group("/api")

	// Unauthenticated routes
	RegisterMonitorRoutes(api)

	// Socket.IO is served directly at the HTTP level (see main.go),
	// bypassing Gin and the CORS wrapper — matching the Node.js architecture
	// where socket.io intercepts before Express middleware.

	// Apply JWT auth middleware to all subsequent /api routes
	api.Use(middleware.JWTAuth())

	// Insight is exempt from the 30s write-deadline timeout — heatmap generation
	// can take 60-120s depending on frame count.
	RegisterInsightRoutes(api)

	api.Use(middleware.Timeout())

	// Authenticated route groups
	RegisterAlertRoutes(api)
	RegisterInvestigationRoutes(api)
	RegisterCameraRoutes(api)
	RegisterMyAlertRoutes(api)
	RegisterInsightReportRoutes(api)
	RegisterDaysRoutes(api)
	RegisterNotificationRoutes(api)
	RegisterKPIReportRoutes(api)

	// Sub-routers with path prefixes
	activeGroup := api.Group("/active")
	RegisterActiveCameraRoutes(activeGroup)

	camGroupGroup := api.Group("/camgroup")
	RegisterCameraGroupRoutes(camGroupGroup)

	notifGroup := api.Group("/notification")
	RegisterCameraNotificationManagerRoutes(notifGroup)

	// NoRoute: try serving static file from AKSHA_PATH, otherwise 404
	r.NoRoute(staticOrNotFound(config.Cfg.AkshaPath))

	// Start scheduled jobs
	go startScheduledJobs()
}

// startScheduledJobs runs periodic tasks like cache cleanup at 22:30 and stats logging.
func startScheduledJobs() {
	// Log stats every minute
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			logServerStats("Periodic")
		}
	}()

	// Schedule daily cache cleanup at 22:30
	for {
		now := time.Now()
		next := time.Date(now.Year(), now.Month(), now.Day(), 22, 30, 0, 0, now.Location())
		if now.After(next) {
			next = next.Add(24 * time.Hour)
		}
		time.Sleep(time.Until(next))
		clearCache()
	}
}

func clearCache() {
	url := fmt.Sprintf("http://%s:4000/DockerClean", config.Cfg.APIService)
	resp, err := http.Post(url, "application/json", nil)
	if err != nil {
		log.Printf("Could not run cache cleanup: %v", err)
		return
	}
	resp.Body.Close()
	log.Println("Cache cleanup completed")
	logServerStats("CacheClean")
}

// staticOrNotFound tries to serve a static file from AKSHA_PATH for unmatched
// routes (like express.static at root). Returns 404 JSON if file doesn't exist.
func staticOrNotFound(root string) gin.HandlerFunc {
	if root == "" {
		return func(c *gin.Context) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Not Found"})
		}
	}
	fs := http.Dir(root)
	fileServer := http.StripPrefix("/", http.FileServer(fs))
	return func(c *gin.Context) {
		// Only serve GET/HEAD as static files
		if c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead {
			f, err := fs.Open(c.Request.URL.Path)
			if err == nil {
				f.Close()
				fileServer.ServeHTTP(c.Writer, c.Request)
				return
			}
		}
		c.JSON(http.StatusNotFound, gin.H{"error": "Not Found"})
	}
}

func logServerStats(prefix string) {
	// In Go we don't have direct access to Node.js-style memory stats,
	// but we log a basic status message for observability.
	log.Printf("[%s] Server stats check", prefix)
}
