package routes

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
)

// insightClient allows up to 5 minutes for the controller to generate the heatmap.
var insightClient = &http.Client{Timeout: 5 * time.Minute}

func RegisterInsightRoutes(api *gin.RouterGroup) {
	api.POST(config.Cfg.Insight, handleInsight)
}

type insightRequest struct {
	CameraName string `json:"Camera_Name"`
	StartDate  string `json:"Start_Date"`
	EndDate    string `json:"End_Date"`
	StartTime  string `json:"Start_Time"`
	EndTime    string `json:"End_Time"`
}

func handleInsight(c *gin.Context) {
	var req insightRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid request", "insight": gin.H{}})
		return
	}
	if req.CameraName == "" || req.StartDate == "" || req.StartTime == "" || req.EndDate == "" || req.EndTime == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "please provide all detail", "insight": gin.H{}})
		return
	}

	// Call service API
	body, _ := json.Marshal(map[string]string{
		"camera_name": req.CameraName, "start_date": req.StartDate,
		"end_date": req.EndDate, "start_time": req.StartTime, "end_time": req.EndTime,
	})
	resp, err := insightClient.Post("http://API_SERVICE:4000/Insight", "application/json", bytes.NewReader(body))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "Could not generate insight video", "insight": gin.H{}})
		return
	}
	resp.Body.Close()

	// Check video file
	filePath := filepath.Join(config.Cfg.AkshaPath, req.CameraName, "insight",
		fmt.Sprintf("heatmap_video_%s.mp4", req.CameraName))
	info, err := os.Stat(filePath)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "Video not found.", "insight": gin.H{}})
		return
	}
	if info.Size() == 0 {
		c.JSON(http.StatusOK, gin.H{"success": true, "message": "Video is still being formed. Please wait", "insight": gin.H{}})
		return
	}

	hashInput := fmt.Sprintf("camera_name: %s, start_date: %s, end_date: %s, start_time: %s, end_time: %s",
		req.CameraName, req.StartDate, req.EndDate, req.StartTime, req.EndTime)
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(hashInput)))

	imageURL := fmt.Sprintf("%s/%s/insight/heatmap_video_%s.mp4?hash=%s",
		config.Cfg.BaseURL(), req.CameraName, req.CameraName, hash)
	c.JSON(http.StatusOK, gin.H{
		"success": true, "message": "fetch insight successful",
		"insight": gin.H{"camera_Name": req.CameraName, "image": imageURL},
	})
}
