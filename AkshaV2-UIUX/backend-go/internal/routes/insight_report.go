package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/bson"

	"github.com/algoanalytics-pvt/aksha-backend/internal/azure"
	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
	"github.com/algoanalytics-pvt/aksha-backend/internal/db"
	"github.com/algoanalytics-pvt/aksha-backend/internal/utils"
)

func RegisterInsightReportRoutes(api *gin.RouterGroup) {
	api.POST(config.Cfg.InsightReport, handleInsightReport)
	api.GET(config.Cfg.MailInsightReportStatus, handleInsightReportStatus)
	api.PUT(config.Cfg.MailInsightReport, handleMailInsightReport)
}

type insightReportRequest struct {
	StartDate         string   `json:"startDate"`
	EndDate           string   `json:"endDate"`
	StartTime         string   `json:"startTime"`
	EndTime           string   `json:"endTime"`
	Cameras           []string `json:"cameras"`
	ObjectsOfInterest []string `json:"objectsOfInterest"`
}

func handleInsightReport(c *gin.Context) {
	var req insightReportRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid request", "report": gin.H{}})
		return
	}
	if req.StartDate == "" || req.EndDate == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "date is missing, or in incorrect format", "report": gin.H{}})
		return
	}
	if req.StartTime == "" || req.EndTime == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "time is missing, or in incorrect format", "report": gin.H{}})
		return
	}

	dates := utils.GetAllDatesBetween(req.StartDate, req.EndDate)

	// Check which files exist
	var existingDates []string
	for _, date := range dates {
		if azure.CheckFileExists(date) {
			existingDates = append(existingDates, date)
		}
	}
	if len(existingDates) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "No data found for the requested date range"})
		return
	}

	// Read and combine files
	combinedData := make(map[string]interface{})
	for _, date := range existingDates {
		data, err := azure.GetFileFromBlob(date)
		if err != nil {
			continue
		}
		var jsonData map[string]interface{}
		if err := json.Unmarshal(data, &jsonData); err != nil {
			continue
		}
		for camName, camData := range jsonData {
			camMap, ok := camData.(map[string]interface{})
			if !ok {
				continue
			}
			if existing, ok := combinedData[camName]; ok {
				existingMap := existing.(map[string]interface{})
				alerts, _ := camMap["alerts"].(map[string]interface{})
				existingAlerts, _ := existingMap["alerts"].(map[string]interface{})
				for timeKey, val := range alerts {
					existingAlerts[date+" "+timeKey] = val
				}
			} else {
				alerts, _ := camMap["alerts"].(map[string]interface{})
				newAlerts := make(map[string]interface{})
				for timeKey, val := range alerts {
					newAlerts[date+" "+timeKey] = val
				}
				camMap["alerts"] = newAlerts
				combinedData[camName] = camMap
			}
		}
	}

	// Filter by cameras
	if len(req.Cameras) > 0 {
		for camName := range combinedData {
			found := false
			for _, c := range req.Cameras {
				if camName == c {
					found = true
					break
				}
			}
			if !found {
				delete(combinedData, camName)
			}
		}
	}

	// Filter by time
	startParts := strings.Split(req.StartTime, ":")
	endParts := strings.Split(req.EndTime, ":")
	if len(startParts) >= 2 && len(endParts) >= 2 {
		// Try HH:MM:SS first, then HH:MM
		startT, err1 := time.Parse("15:04:05", req.StartTime)
		if err1 != nil {
			startT, _ = time.Parse("15:04", req.StartTime)
		}
		endT, err2 := time.Parse("15:04:05", req.EndTime)
		if err2 != nil {
			endT, _ = time.Parse("15:04", req.EndTime)
		}
		for camName, camData := range combinedData {
			camMap, _ := camData.(map[string]interface{})
			alerts, _ := camMap["alerts"].(map[string]interface{})
			for dateTime := range alerts {
				parts := strings.SplitN(dateTime, " ", 2)
				if len(parts) < 2 {
					continue
				}
				t, err := time.Parse("15:04:05", parts[1])
				if err != nil {
					t, err = time.Parse("15:04", parts[1])
					if err != nil {
						continue
					}
				}
				if t.Before(startT) || t.After(endT) {
					delete(alerts, dateTime)
				}
			}
			combinedData[camName] = camMap
		}
	}

	// Filter by objects of interest
	if len(req.ObjectsOfInterest) > 0 {
		for camName, camData := range combinedData {
			camMap, _ := camData.(map[string]interface{})
			alerts, _ := camMap["alerts"].(map[string]interface{})
			for timeKey, alertData := range alerts {
				alertMap, ok := alertData.(map[string]interface{})
				if !ok {
					continue
				}
				obj, _ := alertMap["object"].(string)
				found := false
				for _, oi := range req.ObjectsOfInterest {
					if obj == oi {
						found = true
						break
					}
				}
				if !found {
					delete(alerts, timeKey)
				}
			}
			combinedData[camName] = camMap
		}
	}

	// Recalculate counts
	for camName, camData := range combinedData {
		camMap, _ := camData.(map[string]interface{})
		alerts, _ := camMap["alerts"].(map[string]interface{})
		camMap["total_alerts_generated"] = len(alerts)
		objCounts := make(map[string]int)
		for _, alertData := range alerts {
			alertMap, ok := alertData.(map[string]interface{})
			if !ok {
				continue
			}
			obj, _ := alertMap["object"].(string)
			objCounts[obj]++
		}
		camMap["object_detection_alerts"] = objCounts
		combinedData[camName] = camMap
	}

	if len(combinedData) > 0 {
		c.JSON(http.StatusOK, gin.H{"cameras": combinedData})
	} else {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "No data found for camera"})
	}
}

func handleInsightReportStatus(c *gin.Context) {
	ctx := context.Background()
	coll := db.GetCollection("Resource")
	var resource bson.M
	err := coll.FindOne(ctx, bson.M{}).Decode(&resource)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "send_alert_report": resource["send_alert_report"]})
}

func handleMailInsightReport(c *gin.Context) {
	var req struct {
		SendEmail bool `json:"send_email"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}
	ctx := context.Background()
	coll := db.GetCollection("Resource")
	var resource bson.M
	err := coll.FindOne(ctx, bson.M{}).Decode(&resource)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}
	_, err = coll.UpdateOne(ctx, bson.M{"_id": resource["_id"]},
		bson.M{"$set": bson.M{"send_alert_report": req.SendEmail}})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "message": "Alert Report status modified"})
}
