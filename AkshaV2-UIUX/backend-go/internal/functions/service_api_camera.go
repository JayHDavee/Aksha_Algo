// service_api_camera.go — HTTP client for the Surveillance Service API
// Migrated from: src/functions/serviceApiCamera.js
//
// ServiceApiStartCamera() — POST to API_SERVICE:4000/Surveillance
//   to start/restart camera pipelines
package functions

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"go.mongodb.org/mongo-driver/bson"

	"github.com/algoanalytics-pvt/aksha-backend/internal/db"
	"github.com/algoanalytics-pvt/aksha-backend/internal/models"
)

// CameraStartDetails holds the camera configuration details needed to start a camera pipeline.
type CameraStartDetails struct {
	RtspID           int    `json:"rtsp_id"`
	RtspLink         string `json:"rtsp_link"`
	CameraName       string `json:"camera_name"`
	PrevCameraName   string `json:"prev_camera_name,omitempty"`
	Priority         string `json:"priority"`
	EmailAutoAlert   bool   `json:"email_auto_alert"`
	DisplayAutoAlert bool   `json:"display_auto_alert"`
	EmailAlert       bool   `json:"email_alert"`
	DisplayAlert     bool   `json:"display_alert"`
}

// surveillanceCameraPayload is a single camera entry in the surveillance API request.
type surveillanceCameraPayload struct {
	CameraName       string   `json:"camera_name"`
	UpdateCameraName string   `json:"update_camera_name"`
	RtspID           int      `json:"rtsp_id"`
	RtspLink         string   `json:"rtsp_link"`
	Alerts           []string `json:"alerts"`
	FPS              float64  `json:"fps"`
	EmailAutoAlert   bool     `json:"email_auto_alert"`
	DisplayAutoAlert bool     `json:"display_auto_alert"`
	EmailAlert       bool     `json:"email_alert"`
	DisplayAlert     bool     `json:"display_alert"`
}

// surveillanceRequest is the payload sent to the surveillance API.
type surveillanceRequest struct {
	CameraList []surveillanceCameraPayload `json:"camera_list"`
	Type       string                      `json:"type"`
}

// ServiceApiStartCamera sends a POST request to the surveillance service API
// to start or restart a camera pipeline. If restart is true, the camera_name
// field is set to the previous camera name and update_camera_name to the new name.
func ServiceApiStartCamera(details CameraStartDetails, restart bool) (map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Look up existing alerts for this camera
	alertColl := db.GetCollection(models.AlertCollection)
	cursor, err := alertColl.Find(ctx, bson.M{
		"Camera_Name": bson.M{"$in": bson.A{details.CameraName}},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to query alerts: %w", err)
	}
	defer cursor.Close(ctx)

	var alerts []models.Alert
	if err := cursor.All(ctx, &alerts); err != nil {
		return nil, fmt.Errorf("failed to decode alerts: %w", err)
	}

	alertNames := make([]string, 0, len(alerts))
	for _, a := range alerts {
		alertNames = append(alertNames, a.AlertName)
	}

	// Determine FPS based on priority
	var fps float64
	switch details.Priority {
	case "Low":
		fps = 1.0
	case "High":
		fps = 5.0
	default:
		fps = 3.0
	}

	camPayload := surveillanceCameraPayload{
		CameraName:       details.CameraName,
		UpdateCameraName: details.CameraName,
		RtspID:           details.RtspID,
		RtspLink:         details.RtspLink,
		Alerts:           alertNames,
		FPS:              fps,
		EmailAutoAlert:   details.EmailAutoAlert,
		DisplayAutoAlert: details.DisplayAutoAlert,
		EmailAlert:       details.EmailAlert,
		DisplayAlert:     details.DisplayAlert,
	}

	reqType := "start"
	if restart {
		reqType = "restart"
		camPayload.CameraName = details.PrevCameraName
		camPayload.UpdateCameraName = details.CameraName
	}

	payload := surveillanceRequest{
		CameraList: []surveillanceCameraPayload{camPayload},
		Type:       reqType,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"http://API_SERVICE:4000/Surveillance", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("surveillance API request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var serviceRes map[string]interface{}
	if err := json.Unmarshal(respBody, &serviceRes); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	log.Printf("serviceApi res: %v", serviceRes)
	return serviceRes, nil
}
