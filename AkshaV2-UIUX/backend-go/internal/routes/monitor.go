// monitor.go — Live frame ingestion endpoint (unauthenticated)
// Migrated from: src/routes/monitor.js
package routes

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zishang520/engine.io/v2/types"
	sio "github.com/zishang520/socket.io/v2/socket"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
	"github.com/algoanalytics-pvt/aksha-backend/internal/functions"
	"github.com/algoanalytics-pvt/aksha-backend/internal/socketio"
)

func init() {
	// Register callback to send initial camera list when a client connects
	socketio.SetOnConnectCallback(func(s *sio.Socket) {
		cameraDetail, err := functions.ListLiveCamera()
		if err != nil {
			log.Printf("Socket.IO onConnect: failed to list live cameras: %v", err)
			return
		}
		s.Emit("liveAllCamera", map[string]interface{}{
			"success": true,
			"message": "Initial camera list",
			"info":    cameraDetail,
		})
		log.Printf("[Socket.IO] Sent initial liveAllCamera to %s (%d cameras)", s.Id(), len(cameraDetail))
	})
}

// RegisterMonitorRoutes sets up the monitor endpoint.
func RegisterMonitorRoutes(rg *gin.RouterGroup) {
	rg.POST("/monitor", handleMonitor)
	rg.GET("/debug/socketio", handleDebugSocketIO)
}

// frameStats tracks frame reception for diagnostics.
var (
	frameStatsMu    sync.Mutex
	totalFrames     int64
	lastFrameCamera string
	lastFrameTime   time.Time
)

// handleDebugSocketIO returns Socket.IO status and emits a test event.
func handleDebugSocketIO(c *gin.Context) {
	frameStatsMu.Lock()
	frames := totalFrames
	lastCam := lastFrameCamera
	lastTime := lastFrameTime
	frameStatsMu.Unlock()

	clients := socketio.ConnectedCount()

	// Emit a test liveAllCamera to prove the socket works
	cameraDetail, _ := functions.ListLiveCamera()
	socketio.Emit("liveAllCamera", map[string]interface{}{
		"success": true,
		"message": "Debug test emit",
		"info":    cameraDetail,
	})

	c.JSON(http.StatusOK, gin.H{
		"connected_clients":  clients,
		"total_frames_received": frames,
		"last_frame_camera":  lastCam,
		"last_frame_time":    lastTime,
		"test_emit_sent":     true,
		"test_emit_cameras":  len(cameraDetail),
	})
}

// globalConfig holds the parsed global.json content.
type globalConfig struct {
	Workday string `json:"workday"`
}

// cachedGlobalConfig caches the global.json content to avoid disk I/O on every frame.
var (
	cachedGC      *globalConfig
	cachedGCMu    sync.RWMutex
	cachedGCTime  time.Time
	cachedGCTTL   = 2 * time.Second
)

// liveUpdateTracker debounces liveAllCamera emissions triggered by frame
// reception. When the monitor receives a frame for a camera, the surveillance
// system is running and the camera is live. We re-broadcast the camera list
// so the frontend gets Live: true even if the MongoDB change stream missed it.
var (
	liveUpdateMu   sync.Mutex
	liveUpdateTime time.Time
	liveUpdateTTL  = 5 * time.Second
)

// akshaPathForTest overrides config.Cfg.AkshaPath in tests.
var (
	akshaPathMu      sync.RWMutex
	akshaPathForTest string
)

func getAkshaPath() string {
	akshaPathMu.RLock()
	override := akshaPathForTest
	akshaPathMu.RUnlock()
	if override != "" {
		return override
	}
	return config.Cfg.AkshaPath
}

func readGlobalConfig() (*globalConfig, error) {
	cachedGCMu.RLock()
	if cachedGC != nil && time.Since(cachedGCTime) < cachedGCTTL {
		gc := cachedGC
		cachedGCMu.RUnlock()
		return gc, nil
	}
	cachedGCMu.RUnlock()

	data, err := os.ReadFile(filepath.Join(getAkshaPath(), "global.json"))
	if err != nil {
		return nil, err
	}
	var gc globalConfig
	if err := json.Unmarshal(data, &gc); err != nil {
		return nil, err
	}

	cachedGCMu.Lock()
	cachedGC = &gc
	cachedGCTime = time.Now()
	cachedGCMu.Unlock()

	return &gc, nil
}

func handleMonitor(c *gin.Context) {
	// Read global.json to determine workday/holiday
	gc, err := readGlobalConfig()
	if err != nil {
		c.String(http.StatusInternalServerError, "Error reading global configuration")
		return
	}

	imagetypeDetermine := "holiday"
	if gc.Workday == "true" {
		imagetypeDetermine = "workday"
	}

	cameraName := c.PostForm("camera_name")
	timestamp := c.PostForm("timestamp")

	if cameraName == "" || timestamp == "" {
		c.String(http.StatusBadRequest, "Missing required data: camera_name or timestamp")
		return
	}

	imageType := c.PostForm("image_type")
	cameraImgURL := c.PostForm("camera_img_url")

	// Only broadcast if image_type matches and a file is present
	file, fileHeader, fileErr := c.Request.FormFile("image")

	log.Printf("[Monitor] frame: camera=%s imageType=%s expected=%s fileErr=%v clients=%d",
		cameraName, imageType, imagetypeDetermine, fileErr, socketio.ConnectedCount())

	// Track stats for debug endpoint
	frameStatsMu.Lock()
	totalFrames++
	lastFrameCamera = cameraName
	lastFrameTime = time.Now()
	frameStatsMu.Unlock()

	if imageType == imagetypeDetermine && fileErr == nil && fileHeader != nil {
		// Use io.ReadAll to guarantee the full image is read (file.Read
		// may return partial data in a single call).
		buf, err := io.ReadAll(file)
		if err != nil {
			c.String(http.StatusInternalServerError, "Failed to read image")
			return
		}

		contentType := fileHeader.Header.Get("Content-Type")

		log.Printf("[Monitor] emitting %s frame (%d bytes) to %d clients",
			cameraName, len(buf), socketio.ConnectedCount())

		// Emit directly (s.Emit per socket is fast and non-blocking for
		// the underlying write buffers). No goroutine needed since our
		// Emit iterates tracked sockets and each s.Emit queues internally.
		socketio.Emit(cameraName, map[string]interface{}{
			"image_url": cameraImgURL,
			"type":      contentType,
			"image":     types.NewBytesBuffer(buf),
			"timestamp": timestamp,
		})

		// Re-broadcast the camera list so the frontend picks up
		// Live: true. Debounced to at most once every 5 seconds.
		go maybeBroadcastLiveUpdate()

		// Update reference image if it's missing or still a placeholder
		go updateReferenceImage(cameraName, buf)
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "Successfully Published Image for Camera: " + cameraName,
	})
}

// placeholderSize is the exact size of the "No image Available" placeholder files.
const placeholderSize = 22209

// updateReferenceImage saves a real frame as the reference image if the current
// one is missing or is the placeholder image.
func updateReferenceImage(cameraName string, frameData []byte) {
	// Look up rtsp_id from rtsplinks.json
	rtspPath := filepath.Join(getAkshaPath(), "rtsplinks.json")
	data, err := os.ReadFile(rtspPath)
	if err != nil {
		return
	}
	var rtspData map[string]map[string]interface{}
	if err := json.Unmarshal(data, &rtspData); err != nil {
		return
	}

	rtspID := ""
	for _, v := range rtspData {
		if name, _ := v["cam_name"].(string); name == cameraName {
			rtspID = fmt.Sprintf("%v", v["rtsp_id"])
			break
		}
	}
	if rtspID == "" {
		return
	}

	refDir := filepath.Join(getAkshaPath(), "Reference_images")
	imgPath := filepath.Join(refDir, rtspID+".jpg")

	// Check if reference image needs updating
	info, err := os.Stat(imgPath)
	if err == nil && info.Size() != placeholderSize {
		// Already has a real reference image
		return
	}

	// Save the frame as the new reference image
	if err := os.MkdirAll(refDir, 0755); err != nil {
		log.Printf("[Monitor] Failed to create Reference_images dir: %v", err)
		return
	}
	if err := os.WriteFile(imgPath, frameData, 0644); err != nil {
		log.Printf("[Monitor] Failed to save reference image for %s: %v", cameraName, err)
		return
	}
	log.Printf("[Monitor] Saved reference image for %s → %s", cameraName, imgPath)
}

// maybeBroadcastLiveUpdate sends a liveAllCamera event if enough time has
// passed since the last one. This ensures the frontend gets updated camera
// state (especially Live: true) even when the MongoDB change stream is down.
func maybeBroadcastLiveUpdate() {
	liveUpdateMu.Lock()
	if time.Since(liveUpdateTime) < liveUpdateTTL {
		liveUpdateMu.Unlock()
		return
	}
	liveUpdateTime = time.Now()
	liveUpdateMu.Unlock()

	cameraDetail, err := functions.ListLiveCamera()
	if err != nil {
		return
	}
	socketio.Emit("liveAllCamera", map[string]interface{}{
		"success": true,
		"message": "Update from monitor frame reception",
		"info":    cameraDetail,
	})
}
