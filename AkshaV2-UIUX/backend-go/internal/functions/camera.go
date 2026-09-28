// Package functions contains shared business logic helpers.
// Migrated from: src/functions/camera.js
//
// camera.go:
//   ListLiveCamera()       — build live camera details with image URLs
//   ListSpotlightCameras() — build spotlight camera list with image URLs
package functions

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"

	"go.mongodb.org/mongo-driver/bson"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
	"github.com/algoanalytics-pvt/aksha-backend/internal/db"
	"github.com/algoanalytics-pvt/aksha-backend/internal/models"
)

// LiveCameraResponse is the response shape returned by ListLiveCamera.
type LiveCameraResponse struct {
	ID                 interface{} `json:"_id"`
	RtspID             int         `json:"rtsp_id"`
	RtspLink           string      `json:"Rtsp_Link"`
	CameraName         string      `json:"Camera_Name"`
	Description        string      `json:"Description"`
	Feature            []string    `json:"Feature"`
	Priority           string      `json:"Priority"`
	Status             string      `json:"Status"`
	EmailAutoAlert     bool        `json:"Email_Auto_Alert"`
	DisplayAutoAlert   bool        `json:"Display_Auto_Alert"`
	Active             bool        `json:"Active"`
	FPS                float64     `json:"FPS"`
	Live               bool        `json:"Live"`
	SurveillanceStatus string      `json:"Surveillance_Status"`
	PausedImage        *string     `json:"PausedImage"`
	Image              *string     `json:"image"`
}

// SpotlightCameraResponse is the response shape for spotlight cameras.
type SpotlightCameraResponse struct {
	CameraName string `json:"camera_name"`
	Image      string `json:"image"`
}

// globalJSON represents the structure of the global.json file.
type globalJSON struct {
	Workday string `json:"workday"`
}

// readGlobalWorkday reads the workday value from AKSHA_PATH/global.json.
func readGlobalWorkday() (string, error) {
	data, err := os.ReadFile(filepath.Join(config.Cfg.AkshaPath, "global.json"))
	if err != nil {
		return "", err
	}
	var g globalJSON
	if err := json.Unmarshal(data, &g); err != nil {
		return "", err
	}
	return g.Workday, nil
}

// ListLiveCamera queries the config collection for all cameras and builds
// a response with image URLs derived from the filesystem.
func ListLiveCamera() ([]LiveCameraResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	coll := db.GetCollection(models.ConfigCollection)
	cursor, err := coll.Find(ctx, bson.M{})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var cameras []models.CameraConfig
	if err := cursor.All(ctx, &cameras); err != nil {
		return nil, err
	}

	workday, err := readGlobalWorkday()
	if err != nil {
		log.Printf("ListLiveCamera: failed to read global.json: %v", err)
		workday = ""
	}

	baseURL := config.Cfg.BaseURL()
	result := make([]LiveCameraResponse, 0, len(cameras))

	for _, cam := range cameras {
		liveFolder := filepath.Join(config.Cfg.AkshaPath, cam.CameraName, "live")

		// Determine the workday/holiday image
		var daysImage *string
		if workday == "true" {
			p := filepath.Join(liveFolder, "workday.jpg")
			if fileExists(p) {
				url := baseURL + "/" + cam.CameraName + "/live/workday.jpg"
				daysImage = &url
			}
		} else {
			p := filepath.Join(liveFolder, "holiday.jpg")
			if fileExists(p) {
				url := baseURL + "/" + cam.CameraName + "/live/holiday.jpg"
				daysImage = &url
			}
		}

		// Determine the paused image
		var pausedImage *string
		if !cam.Live && cam.PausedTime != "" {
			// Parse PausedTime to build the file path
			// PausedTime is stored as an ISO timestamp string
			t, parseErr := time.Parse(time.RFC3339, cam.PausedTime)
			if parseErr != nil {
				// Try alternate format
				t, parseErr = time.Parse("2006-01-02T15:04:05.000Z", cam.PausedTime)
			}
			if parseErr == nil {
				dateStr := t.Format("2006-01-02")
				timeStr := t.Format("2006-01-02 15_04_05")
				framePath := filepath.Join(config.Cfg.AkshaPath, cam.CameraName, "frame", dateStr, timeStr+".jpg")
				if fileExists(framePath) {
					url := baseURL + "/" + cam.CameraName + "/frame/" + dateStr + timeStr + ".jpg"
					pausedImage = &url
				}
			}
		}

		// Determine the main image
		var image *string
		if cam.SurveillanceStatus == "stop" {
			stopPath := filepath.Join(config.Cfg.AkshaPath, "stop.jpg")
			if fileExists(stopPath) {
				url := baseURL + "/stop.jpg"
				image = &url
			}
		} else {
			image = daysImage
		}

		result = append(result, LiveCameraResponse{
			ID:                 cam.ID,
			RtspID:             cam.RtspID,
			RtspLink:           cam.RtspLink,
			CameraName:         cam.CameraName,
			Description:        cam.Description,
			Feature:            cam.Feature,
			Priority:           cam.Priority,
			Status:             cam.Status,
			EmailAutoAlert:     cam.EmailAutoAlert,
			DisplayAutoAlert:   cam.DisplayAutoAlert,
			Active:             cam.Active,
			FPS:                cam.FPS,
			Live:               cam.Live,
			SurveillanceStatus: cam.SurveillanceStatus,
			PausedImage:        pausedImage,
			Image:              image,
		})
	}

	return result, nil
}

// ListSpotlightCameras queries the config collection and returns cameras
// that have spotlight images present on the filesystem.
func ListSpotlightCameras() ([]SpotlightCameraResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	coll := db.GetCollection(models.ConfigCollection)
	cursor, err := coll.Find(ctx, bson.M{})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var cameras []models.CameraConfig
	if err := cursor.All(ctx, &cameras); err != nil {
		return nil, err
	}

	workday, err := readGlobalWorkday()
	if err != nil {
		log.Printf("ListSpotlightCameras: failed to read global.json: %v", err)
		workday = ""
	}

	baseURL := config.Cfg.BaseURL()
	var result []SpotlightCameraResponse

	for _, cam := range cameras {
		spotlightDir := filepath.Join(config.Cfg.AkshaPath, cam.CameraName, "spotlight")

		if workday == "true" {
			if fileExists(filepath.Join(spotlightDir, "workday.jpg")) {
				result = append(result, SpotlightCameraResponse{
					CameraName: cam.CameraName,
					Image:      baseURL + "/" + cam.CameraName + "/spotlight/workday.jpg",
				})
			}
		} else {
			if fileExists(filepath.Join(spotlightDir, "holiday.jpg")) {
				result = append(result, SpotlightCameraResponse{
					CameraName: cam.CameraName,
					Image:      baseURL + "/" + cam.CameraName + "/spotlight/holiday.jpg",
				})
			}
		}
	}

	if result == nil {
		result = []SpotlightCameraResponse{}
	}
	return result, nil
}

// fileExists checks whether a file exists at the given path.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
