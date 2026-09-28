// kpi_report.go — KPI report endpoint
// Migrated from: src/routes/kpiReport.js
//
// Endpoints:
//   POST /api/kpi/report — retrieve per-camera object count data for date/time range
package routes

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
	"github.com/algoanalytics-pvt/aksha-backend/internal/utils"
)

func RegisterKPIReportRoutes(rg *gin.RouterGroup) {
	rg.POST(config.Cfg.KPIReport, handleKPIReport)
}

type kpiReportRequest struct {
	Cameras   []string `json:"cameras"`
	StartDate string   `json:"startDate"`
	EndDate   string   `json:"endDate"`
	StartTime string   `json:"startTime"`
	EndTime   string   `json:"endTime"`
}

type kpiRecord struct {
	Timestamp string                 `json:"timestamp"`
	Counts    map[string]interface{} `json:"counts"`
	FrameLink string                 `json:"frame_link"`
}

type kpiCameraReport struct {
	CameraName string      `json:"camera_name"`
	Records    []kpiRecord `json:"records"`
}

func handleKPIReport(c *gin.Context) {
	akshaPath := config.Cfg.AkshaPath
	if akshaPath == "" {
		c.JSON(http.StatusInternalServerError, gin.H{
			"success": false,
			"message": "AKSHA_PATH not set in .env",
		})
		return
	}

	var req kpiReportRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"success": false,
			"message": "invalid request body",
		})
		return
	}

	if len(req.Cameras) == 0 || req.StartDate == "" || req.EndDate == "" || req.StartTime == "" || req.EndTime == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"success": false,
			"message": "Missing required fields: cameras, startDate, endDate, startTime, or endTime",
		})
		return
	}

	allDates := utils.GetAllDatesBetween(req.StartDate, req.EndDate)
	var reports []kpiCameraReport
	var statusMessages []string

	// Read daemon log once
	daemonLogPath := filepath.Join(akshaPath, "daemon_stat.log")
	daemonLogData := ""
	if data, err := os.ReadFile(daemonLogPath); err == nil {
		daemonLogData = string(data)
	}

	for _, cam := range req.Cameras {
		var cameraRecords []kpiRecord

		for _, date := range allDates {
			filePath := filepath.Join(akshaPath, "kpi_report", date+".json")

			if _, err := os.Stat(filePath); os.IsNotExist(err) {
				if daemonLogData != "" && !hasConsecutiveTrueStatus(daemonLogData, date) {
					msg := "Skipped " + date + ": Daemon inactive (no KPI data for " + cam + ")."
					log.Println(msg)
					statusMessages = append(statusMessages, msg)
				} else {
					msg := "Skipped " + date + ": KPI file not found for " + cam + ", but daemon was active."
					log.Println(msg)
					statusMessages = append(statusMessages, msg)
				}
				continue
			}

			fileData, err := os.ReadFile(filePath)
			if err != nil {
				continue
			}

			var jsonData map[string]json.RawMessage
			if err := json.Unmarshal(fileData, &jsonData); err != nil {
				continue
			}

			camRaw, ok := jsonData[cam]
			if !ok {
				continue
			}

			var camData struct {
				Frames map[string]struct {
					Timestamp    string                 `json:"timestamp"`
					ObjectCounts map[string]interface{} `json:"object_counts"`
					FrameLink    string                 `json:"frame_link"`
				} `json:"frames"`
			}
			if err := json.Unmarshal(camRaw, &camData); err != nil {
				continue
			}
			if camData.Frames == nil {
				continue
			}

			for timeKey, frame := range camData.Frames {
				if isKPITimeInRange(timeKey, req.StartTime, req.EndTime) {
					cameraRecords = append(cameraRecords, kpiRecord{
						Timestamp: frame.Timestamp,
						Counts:    frame.ObjectCounts,
						FrameLink: frame.FrameLink,
					})
				}
			}
		}

		if len(cameraRecords) > 0 {
			reports = append(reports, kpiCameraReport{
				CameraName: cam,
				Records:    cameraRecords,
			})
		}
	}

	if len(reports) == 0 {
		c.JSON(http.StatusNotFound, gin.H{
			"success":     false,
			"message":     "No KPI data found for the given criteria",
			"daemon_logs": statusMessages,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"report":  reports,
	})
}

// hasConsecutiveTrueStatus checks if the daemon log shows at least 4
// consecutive "True" entries for the given date.
func hasConsecutiveTrueStatus(logData, date string) bool {
	lines := strings.Split(logData, "\n")
	consecutiveTrueCount := 0

	for _, line := range lines {
		parts := strings.Fields(line)
		if len(parts) >= 3 && parts[0] == date && parts[2] == "True" {
			consecutiveTrueCount++
			if consecutiveTrueCount >= 4 {
				return true
			}
		} else {
			consecutiveTrueCount = 0
		}
	}

	return false
}

// isKPITimeInRange checks whether a frame time (HH:MM or HH:MM:SS) falls
// within [startTime, endTime] based on minutes.
func isKPITimeInRange(frameTime, startTime, endTime string) bool {
	frameMins := parseHHMM(frameTime)
	startMins := parseHHMM(startTime)
	endMins := parseHHMM(endTime)
	return frameMins >= startMins && frameMins <= endMins
}

func parseHHMM(t string) int {
	parts := strings.Split(t, ":")
	if len(parts) < 2 {
		return 0
	}
	h, _ := strconv.Atoi(parts[0])
	m, _ := strconv.Atoi(parts[1])
	return h*60 + m
}
