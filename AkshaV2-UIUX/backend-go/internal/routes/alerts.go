package routes

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
	"github.com/algoanalytics-pvt/aksha-backend/internal/db"
	"github.com/algoanalytics-pvt/aksha-backend/internal/utils"
)

func RegisterAlertRoutes(api *gin.RouterGroup) {
	api.POST(config.Cfg.MyAlert, handleMyAlert)
	api.POST(config.Cfg.AutoAlert, handleAutoAlert)
	api.POST(config.Cfg.UserFeedback, handleUserFeedback)
	api.GET(config.Cfg.RecentAlert, handleRecentAlert)
	api.POST(config.Cfg.ObjectOfInterest, handleObjectOfInterest)
}

type myAlertRequest struct {
	StartTime  string `json:"Start_Time"`
	EndTime    string `json:"End_Time"`
	CameraName string `json:"Camera_Name"`
	StartDate  string `json:"Start_Date"`
	EndDate    string `json:"End_Date"`
}

func handleMyAlert(c *gin.Context) {
	var req myAlertRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid request body"})
		return
	}
	log.Printf("[MyAlert] Request: Camera=%q StartDate=%q EndDate=%q StartTime=%q EndTime=%q", req.CameraName, req.StartDate, req.EndDate, req.StartTime, req.EndTime)
	if req.StartTime == "" || req.EndTime == "" || req.CameraName == "" || req.StartDate == "" || req.EndDate == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "please provide all detail"})
		return
	}

	ctx := context.Background()
	coll := db.GetCollection("config")
	cursor, err := coll.Find(ctx, bson.M{})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error(), "alert": []interface{}{}})
		return
	}
	var cameras []bson.M
	if err := cursor.All(ctx, &cameras); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error(), "alert": []interface{}{}})
		return
	}

	// Filter camera names containing the requested name
	var matchingCameras []string
	for _, cam := range cameras {
		name, _ := cam["Camera_Name"].(string)
		if strings.Contains(name, req.CameraName) {
			matchingCameras = append(matchingCameras, name)
		}
	}

	baseURL := config.Cfg.BaseURL()
	var filterAlert []gin.H

	for _, cameraName := range matchingCameras {
		// Collect images across date range
		var images []string
		for _, date := range utils.GetAllDatesBetween(req.StartDate, req.EndDate) {
			dir := filepath.Join(config.Cfg.AkshaPath, cameraName, "alerts", date)
			entries, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			for _, e := range entries {
				images = append(images, e.Name())
			}
		}

		// Filter _alert.jpg images within time range
		var matched []string
		for _, img := range images {
			if !strings.HasSuffix(img, "_alert.jpg") {
				continue
			}
			dateStr := strings.Replace(img, "_alert.jpg", "", 1)
			if isInTimeRange(dateStr, req.StartDate, req.EndDate, req.StartTime, req.EndTime) {
				matched = append(matched, img)
			}
		}

		log.Printf("[MyAlert] Camera=%q total_images=%d alert_images=%d matched=%d", cameraName, len(images), len(images), len(matched))
		if len(matched) > 0 && cameraName == req.CameraName {
			var urls []string
			for _, img := range matched {
				imgDate := strings.SplitN(img, " ", 2)[0]
				if imgDate == "" {
					parts := strings.SplitN(strings.Replace(img, "_alert.jpg", "", 1), "T", 2)
					if len(parts) > 0 {
						imgDate = parts[0]
					}
				}
				// Try to extract date from the image filename
				ts := strings.Replace(img, "_alert.jpg", "", 1)
				parsed, perr := time.ParseInLocation("2006-01-02 15:04:05", ts, time.Local)
				if perr != nil {
					parsed, perr = time.ParseInLocation("2006-01-02 15_04_05", ts, time.Local)
				}
				if perr == nil {
					imgDate = parsed.Format("2006-01-02")
				}
				urls = append(urls, fmt.Sprintf("%s/%s/alerts/%s/%s", baseURL, cameraName, imgDate, img))
			}
			filterAlert = append(filterAlert, gin.H{"cameraName": cameraName, "images": urls})
		}
	}

	if filterAlert == nil {
		filterAlert = []gin.H{}
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "My Alerts are found successfully",
		"alert":   filterAlert,
	})
}

type autoAlertRequest struct {
	CameraName string `json:"camera_name"`
	StartDate  string `json:"start_date"`
	EndDate    string `json:"end_date"`
	StartTime  string `json:"start_time"`
	EndTime    string `json:"end_time"`
}

func handleAutoAlert(c *gin.Context) {
	var req autoAlertRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid request", "alert": []interface{}{}})
		return
	}
	if req.CameraName == "" || req.StartDate == "" || req.EndDate == "" || req.StartTime == "" || req.EndTime == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "please provide proper data to find alert", "alert": []interface{}{}})
		return
	}

	ctx := context.Background()

	// Get meta collection
	metaColl := db.GetCollection("meta_" + req.CameraName)
	cursor, err := metaColl.Find(ctx, bson.M{})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error(), "alert": []interface{}{}})
		return
	}
	var findMeta []bson.M
	_ = cursor.All(ctx, &findMeta)

	// Get matching camera names
	configColl := db.GetCollection("config")
	camCursor, _ := configColl.Find(ctx, bson.M{})
	var allCams []bson.M
	_ = camCursor.All(ctx, &allCams)

	var matchingCameras []string
	for _, cam := range allCams {
		name, _ := cam["Camera_Name"].(string)
		if strings.Contains(name, req.CameraName) {
			matchingCameras = append(matchingCameras, name)
		}
	}

	baseURL := config.Cfg.BaseURL()
	var filterAlert []gin.H

	for _, cameraName := range matchingCameras {
		var images []string
		for _, date := range utils.GetAllDatesBetween(req.StartDate, req.EndDate) {
			dir := filepath.Join(config.Cfg.AkshaPath, cameraName, "alerts", date)
			entries, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			for _, e := range entries {
				images = append(images, e.Name())
			}
		}

		// Filter _autoalert.jpg
		var filtered []string
		for _, img := range images {
			if !strings.HasSuffix(img, "_autoalert.jpg") {
				continue
			}
			dateStr := strings.Replace(img, "_autoalert.jpg", "", 1)
			dateStr = strings.Replace(dateStr, "_", ":", 1)
			dateStr = strings.Replace(dateStr, "_", ":", 1)
			if isInTimeRange(dateStr, req.StartDate, req.EndDate, req.StartTime, req.EndTime) {
				filtered = append(filtered, img)
			}
		}

		if len(filtered) > 0 && cameraName == req.CameraName {
			// Map timestamps
			var newDates []string
			for _, f := range filtered {
				ds := strings.Replace(f, "_autoalert.jpg", "", 1)
				ds = strings.Replace(ds, "_", ":", 1)
				ds = strings.Replace(ds, "_", ":", 1)
				parsed, perr := time.ParseInLocation("2006-01-02 15:04:05", ds, time.Local)
				if perr == nil {
					newDates = append(newDates, parsed.UTC().Format("2006-01-02 15:04:05"))
				}
			}

			// Cross-reference with meta
			var info []gin.H
			for _, meta := range findMeta {
				ts, _ := meta["Timestamp"].(primitive.DateTime)
				metaTime := time.Unix(int64(ts)/1000, 0).UTC()
				metaStr := metaTime.Format("2006-01-02 15:04:05")
				for _, nd := range newDates {
					if nd == metaStr {
						info = append(info, gin.H{
							"_id":          meta["_id"],
							"UserFeedback": meta["UserFeedback"],
							"images": fmt.Sprintf("%s/%s/alerts/%s/%s_autoalert.jpg",
								baseURL, cameraName, metaTime.Format("2006-01-02"), metaStr),
						})
					}
				}
			}

			filterAlert = append(filterAlert, gin.H{"cameraName": cameraName, "info": info})
		}
	}

	if filterAlert == nil {
		filterAlert = []gin.H{}
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "Auto Alerts are found successfully",
		"alert":   filterAlert,
	})
}

type userFeedbackRequest struct {
	CameraName   string `json:"cameraName"`
	ID           string `json:"_id"`
	UserFeedback bool   `json:"UserFeedback"`
}

func handleUserFeedback(c *gin.Context) {
	var req userFeedbackRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid request"})
		return
	}
	if req.CameraName == "" || req.ID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "please provide required field"})
		return
	}

	ctx := context.Background()
	objID, err := primitive.ObjectIDFromHex(req.ID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid id"})
		return
	}

	metaColl := db.GetCollection("meta_" + req.CameraName)
	_, err = metaColl.UpdateOne(ctx, bson.M{"_id": objID}, bson.M{"$set": bson.M{"UserFeedback": !req.UserFeedback}})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "message": "user feedback submitted successfully"})
}

func handleRecentAlert(c *gin.Context) {
	hoursStr := c.Param("hours")
	hours, err := strconv.Atoi(hoursStr)
	if err != nil {
		hours = 1
	}

	ctx := context.Background()
	coll := db.GetCollection("config")
	cursor, err := coll.Find(ctx, bson.M{})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error(), "alert": []interface{}{}})
		return
	}
	var cameras []bson.M
	_ = cursor.All(ctx, &cameras)

	now := time.Now()
	fromTime := now.Add(-time.Duration(hours) * time.Hour)
	baseURL := config.Cfg.BaseURL()

	var filterAlert []gin.H

	for _, cam := range cameras {
		cameraName, _ := cam["Camera_Name"].(string)
		var images []string

		// Read across date range
		for d := fromTime; !d.After(now); d = d.AddDate(0, 0, 1) {
			date := d.Format("2006-01-02")
			dir := filepath.Join(config.Cfg.AkshaPath, cameraName, "alerts", date)
			entries, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			for _, e := range entries {
				images = append(images, e.Name())
			}
		}

		// Filter by time range
		var matched []string
		for _, img := range images {
			dateStr := img
			dateStr = strings.Replace(dateStr, "_autoalert.jpg", "", 1)
			dateStr = strings.Replace(dateStr, "_alert.jpg", "", 1)
			dateStr = strings.Replace(dateStr, "_", ":", 1)
			dateStr = strings.Replace(dateStr, "_", ":", 1)
			// Parse in local timezone since surveillance saves files with local timestamps
			parsed, perr := time.ParseInLocation("2006-01-02 15:04:05", dateStr, time.Local)
			if perr != nil {
				continue
			}
			if (parsed.Equal(fromTime) || parsed.After(fromTime)) && (parsed.Equal(now) || parsed.Before(now)) {
				matched = append(matched, img)
			}
		}

		if len(matched) > 0 {
			var urls []string
			for _, img := range matched {
				folderDate := strings.SplitN(img, " ", 2)[0]
				urls = append(urls, fmt.Sprintf("%s/%s/alerts/%s/%s", baseURL, cameraName, folderDate, img))
			}
			// Reverse
			for i, j := 0, len(urls)-1; i < j; i, j = i+1, j-1 {
				urls[i], urls[j] = urls[j], urls[i]
			}
			filterAlert = append(filterAlert, gin.H{"cameraName": cameraName, "images": urls})
		}
	}

	if filterAlert == nil {
		filterAlert = []gin.H{}
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "Recent Alerts are found successfully",
		"alert":   filterAlert,
	})
}

type objectOfInterestRequest struct {
	CameraName       string        `json:"camera_name"`
	StartDate        string        `json:"start_date"`
	EndDate          string        `json:"end_date"`
	StartTime        string        `json:"start_time"`
	EndTime          string        `json:"end_time"`
	ObjectOfInterest []string      `json:"object_of_interest"`
	AreaOfInterest   [][]float64   `json:"area_of_interest"`
}

func handleObjectOfInterest(c *gin.Context) {
	var req objectOfInterestRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		log.Printf("[ObjectOfInterest] JSON bind error: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "Unable to find alert", "alert": []interface{}{}})
		return
	}
	log.Printf("[ObjectOfInterest] Received: camera=%s dates=%s-%s objects=%v aoi=%v",
		req.CameraName, req.StartDate, req.EndDate, req.ObjectOfInterest, req.AreaOfInterest)
	if req.CameraName == "" || req.StartDate == "" || req.EndDate == "" || req.StartTime == "" || req.EndTime == "" || len(req.ObjectOfInterest) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "Unable to find alert", "alert": []interface{}{}})
		return
	}

	ctx := context.Background()

	// Check if meta collection exists
	collections, _ := db.DB.ListCollectionNames(ctx, bson.M{})
	metaName := ""
	for _, col := range collections {
		if strings.Contains(col, "meta_"+req.CameraName) {
			metaName = col
			break
		}
	}
	if metaName == "" {
		c.JSON(http.StatusOK, gin.H{"success": true, "message": "No data found for the given camera", "alert": []interface{}{}})
		return
	}

	metaColl := db.GetCollection(metaName)
	cursor, err := metaColl.Find(ctx, bson.M{"Results": bson.M{"$not": bson.M{"$size": 0}}})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error(), "alert": []interface{}{}})
		return
	}
	var filterMeta []bson.M
	_ = cursor.All(ctx, &filterMeta)

	camName := strings.SplitN(metaName, "meta_", 2)[1]
	baseURL := config.Cfg.BaseURL()

	// Build alert entries
	var allAlert []gin.H
	for _, data := range filterMeta {
		ts, _ := data["Timestamp"].(primitive.DateTime)
		metaTime := time.Unix(int64(ts)/1000, 0).UTC()
		dateStr := metaTime.Format("2006-01-02")
		timeStr := metaTime.Format("2006-01-02 15:04:05")

		// Check frame file exists
		framePath := filepath.Join(config.Cfg.AkshaPath, camName, "frame", dateStr, timeStr+".jpg")
		imageURL := ""
		if _, err := os.Stat(framePath); err == nil {
			imageURL = fmt.Sprintf("%s/%s/frame/%s/%s.jpg", baseURL, camName, dateStr, timeStr)
		}

		// Extract results
		results, _ := data["Results"].(primitive.A)
		var resultEntries []gin.H
		for _, r := range results {
			rm, ok := r.(bson.M)
			if !ok {
				continue
			}
			label, _ := rm["label"].(string)
			x := toFloat64(rm["x"])
			y := toFloat64(rm["y"])
			w := toFloat64(rm["w"])
			h := toFloat64(rm["h"])
			resultEntries = append(resultEntries, gin.H{
				"label": label,
				"x":     [2]float64{x, y},
				"y":     [2]float64{x + w, y},
				"w":     [2]float64{x + w, y + h},
				"h":     [2]float64{x, y + h},
			})
		}

		allAlert = append(allAlert, gin.H{
			"_id":            data["_id"],
			"Timestamp":      data["Timestamp"],
			"Results":        resultEntries,
			"Frame_Anomaly":  data["Frame_Anomaly"],
			"Object_Anomaly": data["Object_Anomaly"],
			"camera_name":    camName,
			"image":          imageURL,
		})
	}

	// Filter by time range
	var filterOnTime []gin.H
	for _, entry := range allAlert {
		ts, _ := entry["Timestamp"].(primitive.DateTime)
		metaTime := time.Unix(int64(ts)/1000, 0).UTC()
		if isTimeInWindow(metaTime, req.StartDate, req.EndDate, req.StartTime, req.EndTime) {
			filterOnTime = append(filterOnTime, entry)
		}
	}

	// Reverse
	for i, j := 0, len(filterOnTime)-1; i < j; i, j = i+1, j-1 {
		filterOnTime[i], filterOnTime[j] = filterOnTime[j], filterOnTime[i]
	}

	// Filter by object of interest
	containsCrowd := false
	for _, o := range req.ObjectOfInterest {
		if o == "crowd" {
			containsCrowd = true
			break
		}
	}
	containsPerson := false
	for _, o := range req.ObjectOfInterest {
		if o == "person" {
			containsPerson = true
			break
		}
	}

	var filterAlert []gin.H
	for _, entry := range filterOnTime {
		results, _ := entry["Results"].([]gin.H)
		var filtered []gin.H

		if containsCrowd {
			personCount := 0
			for _, r := range results {
				if r["label"] == "person" {
					personCount++
				}
			}
			for _, r := range results {
				label, _ := r["label"].(string)
				if label == "person" && (personCount >= 6 || containsPerson) {
					filtered = append(filtered, r)
				} else if label != "person" {
					for _, oi := range req.ObjectOfInterest {
						if label == oi {
							filtered = append(filtered, r)
							break
						}
					}
				}
			}
		} else {
			for _, r := range results {
				label, _ := r["label"].(string)
				for _, oi := range req.ObjectOfInterest {
					if label == oi {
						filtered = append(filtered, r)
						break
					}
				}
			}
		}

		if len(filtered) > 0 {
			entry["Results"] = filtered
			filterAlert = append(filterAlert, entry)
		}
	}

	// Area of interest filtering
	if len(req.AreaOfInterest) > 0 {
		// Convert [][]float64 to [][2]float64 for polygon check
		var aoiPoly [][2]float64
		for _, pt := range req.AreaOfInterest {
			if len(pt) >= 2 {
				aoiPoly = append(aoiPoly, [2]float64{pt[0], pt[1]})
			}
		}
		var aoiFiltered []gin.H
		for _, entry := range filterAlert {
			results, _ := entry["Results"].([]gin.H)
			var insidePoints []gin.H
			for _, r := range results {
				xArr, _ := r["x"].([2]float64)
				yArr, _ := r["y"].([2]float64)
				hArr, _ := r["h"].([2]float64)
				centroidX := (xArr[0] + yArr[0]) / 2
				centroidY := (xArr[1] + hArr[1]) / 2
				centroid := [2]float64{centroidX, centroidY}
				if utils.IsPointInsidePolygon(centroid, aoiPoly) {
					insidePoints = append(insidePoints, r)
				}
			}
			if len(insidePoints) > 0 {
				entry["Results"] = insidePoints
				aoiFiltered = append(aoiFiltered, entry)
			}
		}
		filterAlert = aoiFiltered
	}

	if filterAlert == nil {
		filterAlert = []gin.H{}
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "Data found successfully",
		"alert":   filterAlert,
	})
}

// isInTimeRange checks if a datetime string falls within the given date+time window.
func isInTimeRange(dateStr, startDate, endDate, startTime, endTime string) bool {
	layouts := []string{"2006-01-02 15:04:05", "2006-01-02 15_04_05", "2006-01-02T15:04:05"}
	var parsed time.Time
	var err error
	for _, layout := range layouts {
		parsed, err = time.ParseInLocation(layout, dateStr, time.Local)
		if err == nil {
			break
		}
	}
	if err != nil {
		return false
	}

	startDate = utils.NormalizeDate(startDate)
	endDate = utils.NormalizeDate(endDate)
	startDT, err1 := time.ParseInLocation("2006-01-02 15:04", startDate+" "+startTime, time.Local)
	endDT, err2 := time.ParseInLocation("2006-01-02 15:04", endDate+" "+endTime, time.Local)
	if err1 != nil || err2 != nil {
		// Try with seconds
		startDT, err1 = time.ParseInLocation("2006-01-02 15:04:05", startDate+" "+startTime, time.Local)
		endDT, err2 = time.ParseInLocation("2006-01-02 15:04:05", endDate+" "+endTime, time.Local)
		if err1 != nil || err2 != nil {
			return false
		}
	}

	if parsed.Before(startDT) || parsed.After(endDT) {
		return false
	}

	// Also check time-of-day
	pTime := parsed.Hour()*60 + parsed.Minute()
	st := parseTimeMinutes(startTime)
	et := parseTimeMinutes(endTime)
	return pTime >= st && pTime <= et
}

func parseTimeMinutes(t string) int {
	parts := strings.Split(t, ":")
	if len(parts) < 2 {
		return 0
	}
	h, _ := strconv.Atoi(parts[0])
	m, _ := strconv.Atoi(parts[1])
	return h*60 + m
}

func isTimeInWindow(t time.Time, startDate, endDate, startTime, endTime string) bool {
	return isInTimeRange(t.Format("2006-01-02 15:04:05"), startDate, endDate, startTime, endTime)
}

// toFloat64 converts BSON numeric values (int32, int64, float64) to float64.
func toFloat64(v interface{}) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int32:
		return float64(n)
	case int64:
		return float64(n)
	default:
		return 0
	}
}

// Suppress unused import warnings
var _ = log.Println
var _ = sort.Strings
