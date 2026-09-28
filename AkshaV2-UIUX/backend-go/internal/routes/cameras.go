package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	"go.mongodb.org/mongo-driver/mongo"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
	"github.com/algoanalytics-pvt/aksha-backend/internal/db"
)

func RegisterCameraRoutes(api *gin.RouterGroup) {
	api.POST(config.Cfg.CameraCreate, handleCameraCreate)
	api.GET(config.Cfg.CameraList, handleCameraList)
	api.POST(config.Cfg.CameraLimit, handleCameraLimit)
	api.PUT(config.Cfg.UpdateCamera, handleCameraUpdate)
	api.DELETE(config.Cfg.DeleteCamera, handleCameraDelete)
	api.GET(config.Cfg.ActivateCamera, handleCameraActivate)
	api.GET(config.Cfg.ActiveEmailAutoAlert, handleActiveEmailAutoAlert)
	api.GET(config.Cfg.ActiveDisplayAutoAlert, handleActiveDisplayAutoAlert)
	api.GET(config.Cfg.ActiveEmailAlert, handleActiveEmailAlert)
	api.GET(config.Cfg.ActiveDisplayAlert, handleActiveDisplayAlert)
	api.GET(config.Cfg.EnableCamera, handleEnableCamera)
	api.GET(config.Cfg.SurveillanceStatus, handleSurveillanceStatus)
	api.GET(config.Cfg.FeatureFlags, handleFeatureFlags)
}

func handleFeatureFlags(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"success":           true,
		"PPE_DETECTION":     config.Cfg.PPEDetection,
		"JEWELRY_DETECTION": config.Cfg.JewelryDetection,
	})
}

// detectionTypeToDeploymentMode maps a camera's Detection_Type to the Python
// controller's deployment_mode string. "standard" (or empty) maps to "" so
// the caller omits the field entirely and the controller's own default
// applies unchanged — mirrors resolveDeploymentMode in the Node backend's
// cameras.ts exactly, including enforcing the flag server-side rather than
// trusting the frontend to hide the option.
func detectionTypeToDeploymentMode(detectionType string) (deploymentMode string, ok bool, errMsg string) {
	switch detectionType {
	case "", "standard":
		return "", true, ""
	case "ppe":
		if !config.Cfg.PPEDetection {
			return "", false, "PPE detection is not enabled"
		}
		return "ppe", true, ""
	case "jewelry":
		if !config.Cfg.JewelryDetection {
			return "", false, "Jewelry detection is not enabled"
		}
		return "jewelry", true, ""
	default:
		return "", false, fmt.Sprintf("Unknown Detection_Type: %s", detectionType)
	}
}

const (
	fpsHigh    = 5.0
	fpsDefault = 3.0
	fpsMin     = 1.0
)

func priorityToFPS(priority string) float64 {
	switch priority {
	case "Low":
		return fpsMin
	case "High":
		return fpsHigh
	default:
		return fpsDefault
	}
}

func readAppConfig() map[string]string {
	data, err := os.ReadFile(filepath.Join(config.Cfg.AkshaPath, "app.config"))
	if err != nil {
		return nil
	}
	lines := strings.Split(string(data), "\n")
	conf := make(map[string]string)
	// Skip first line (INI section header), parse key=value
	for i, line := range lines {
		if i == 0 || strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 {
			conf[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
		}
	}
	return conf
}

func readAppID() (string, error) {
	conf := readAppConfig()
	if conf == nil {
		return "", fmt.Errorf("failed to read app.config")
	}
	// The file uses lowercase "app_id"
	if v, ok := conf["app_id"]; ok {
		return v, nil
	}
	if v, ok := conf["APP_ID"]; ok {
		return v, nil
	}
	return "", fmt.Errorf("APP_ID not found in app.config")
}

func getCameraLimit(appID string) (int, error) {
	body, _ := json.Marshal(map[string]string{"AppID": appID})
	resp, err := http.Post(
		"https://8ygyexnre1.execute-api.ap-south-1.amazonaws.com/dev/get-camera-limit",
		"application/json", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return 0, err
	}
	maxCam, _ := result["MaxCamera"].(float64)
	return int(maxCam), nil
}

type cameraCreateRequest struct {
	CameraName     string   `json:"Camera_Name"`
	RtspLink       string   `json:"Rtsp_Link"`
	Priority       string   `json:"Priority"`
	Feature        []string `json:"Feature"`
	Description    string   `json:"Description"`
	RtspID         string   `json:"rtsp_id"` // frontend sends as string "47"
	DetectionType  string   `json:"Detection_Type"`
}

func handleCameraCreate(c *gin.Context) {
	var req cameraCreateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid request"})
		return
	}
	if req.CameraName == "" || req.RtspLink == "" || req.Priority == "" || len(req.Feature) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "please fill the missing information"})
		return
	}

	deploymentMode, ok, errMsg := detectionTypeToDeploymentMode(req.DetectionType)
	if !ok {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": errMsg})
		return
	}

	ctx := context.Background()
	coll := db.GetCollection("config")

	// Check duplicate name — exact case-insensitive match (prefix "^cam4" would wrongly match cam40..cam49)
	count, _ := coll.CountDocuments(ctx, bson.M{
		"Camera_Name": bson.M{"$regex": "^" + strings.ToLower(req.CameraName) + "$", "$options": "i"},
	})
	if count > 0 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "camera name already exists"})
		return
	}

	// Check camera limit — soft-fail: if app.config/AWS unreachable, allow creation
	distinctLinks, _ := coll.Distinct(ctx, "Rtsp_Link", bson.M{})
	if appID, err := readAppID(); err == nil {
		if maxCam, err := getCameraLimit(appID); err == nil && len(distinctLinks) >= maxCam {
			c.JSON(http.StatusOK, gin.H{"success": true, "isCamLimitExceeded": true, "message": "Camera limit exceeded"})
			return
		}
	}

	rtspIDInt, _ := strconv.Atoi(req.RtspID)
	fps := priorityToFPS(req.Priority)
	detectionTypeStored := req.DetectionType
	if detectionTypeStored == "" {
		detectionTypeStored = "standard"
	}
	doc := bson.M{
		"rtsp_id": rtspIDInt, "Rtsp_Link": req.RtspLink, "Camera_Name": req.CameraName,
		"Description": req.Description, "Feature": req.Feature, "Priority": req.Priority,
		"Status": "creating", "Email_Auto_Alert": true, "Display_Auto_Alert": true,
		"Email_Alert": true, "Display_Alert": true, "FPS": fps, "Alerts": bson.A{},
		"Active": true, "Live": true, "Surveillance_Status": "start", "PausedTime": "null",
		"Detection_Type": detectionTypeStored,
	}
	if _, err := coll.InsertOne(ctx, doc); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}

	// Call service API (fire and forget) — matches Node.js serviceApiStartCamera payload
	cameraStartItem := map[string]interface{}{
		"rtsp_id":            rtspIDInt,
		"rtsp_link":          req.RtspLink,
		"camera_name":        req.CameraName,
		"update_camera_name": req.CameraName,
		"alerts":             []string{},
		"fps":                fps,
		"email_auto_alert":   true,
		"display_auto_alert": true,
		"email_alert":        true,
		"display_alert":      true,
	}
	// Omitted entirely for "standard" so the controller's own default
	// (deepstream_nvinfer/deepstream_batch) applies unchanged, matching the
	// Node backend's serviceApiCamera.ts behavior exactly.
	if deploymentMode != "" {
		cameraStartItem["deployment_mode"] = deploymentMode
	}
	go callSurveillanceAPI(map[string]interface{}{
		"camera_list": []map[string]interface{}{cameraStartItem},
		"type": "start",
	})

	time.Sleep(3 * time.Second)
	c.JSON(http.StatusOK, gin.H{"success": true, "isCamLimitExceeded": false, "message": "camera creation successful"})
}

func handleCameraList(c *gin.Context) {
	ctx := context.Background()
	coll := db.GetCollection("config")
	cursor, err := coll.Find(ctx, bson.M{})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "unable to get cameras"})
		return
	}
	var cameras []bson.M
	_ = cursor.All(ctx, &cameras)

	baseURL := config.Cfg.BaseURL()
	var result []gin.H
	for _, info := range cameras {
		// Reference images are saved by rtsp_id (e.g. 1.jpg, 2.jpg), not Camera_Name
		rtspID := fmt.Sprintf("%v", info["rtsp_id"])
		imgPath := filepath.Join(config.Cfg.AkshaPath, "Reference_images", rtspID+".jpg")
		imageURL := ""
		if _, err := os.Stat(imgPath); err == nil {
			imageURL = fmt.Sprintf("%s/Reference_images/%s.jpg", baseURL, rtspID)
		} else {
			log.Printf("[CameraList] Reference image not found: %s (err: %v)", imgPath, err)
		}
		result = append(result, gin.H{
			"_id": info["_id"], "Rtsp_Link": info["Rtsp_Link"], "Camera_Name": info["Camera_Name"],
			"Description": info["Description"], "Feature": info["Feature"], "Priority": info["Priority"],
			"Status": info["Status"], "Email_Auto_Alert": info["Email_Auto_Alert"],
			"Display_Auto_Alert": info["Display_Auto_Alert"], "Email_Alert": info["Email_Alert"],
			"Display_Alert": info["Display_Alert"], "Skip_Interval": info["Skip_Interval"],
			"Alert": info["Alert"], "image": imageURL, "Active": info["Active"],
			"rtsp_id": info["rtsp_id"], "FPS": info["FPS"], "Live": info["Live"],
			"Surveillance_Status": info["Surveillance_Status"], "PausedTime": info["PausedTime"],
			"Alerts": info["Alerts"], "Detection_Type": info["Detection_Type"],
		})
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "message": "fetch camera successful", "cameras": result})
}

func handleCameraLimit(c *gin.Context) {
	ctx := context.Background()
	coll := db.GetCollection("config")
	distinctLinks, _ := coll.Distinct(ctx, "Rtsp_Link", bson.M{})

	appID, err := readAppID()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}
	maxCam, err := getCameraLimit(appID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}

	exceeded := len(distinctLinks) >= maxCam
	msg := "Camera limit not exceeded"
	if exceeded {
		msg = "Camera limit exceeded"
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true, "camLimit": maxCam, "isCamLimitExceeded": exceeded, "message": msg,
	})
}

func handleCameraUpdate(c *gin.Context) {
	id := c.Param("id")
	objID, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid camera id"})
		return
	}
	var req map[string]interface{}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid request"})
		return
	}

	ctx := context.Background()
	coll := db.GetCollection("config")

	// Find old camera
	var oldCam bson.M
	err = coll.FindOne(ctx, bson.M{"_id": objID}).Decode(&oldCam)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "camera not found"})
		return
	}
	oldName, _ := oldCam["Camera_Name"].(string)
	newName, _ := req["Camera_Name"].(string)
	priority, _ := req["Priority"].(string)
	fps := priorityToFPS(priority)

	detectionType, _ := req["Detection_Type"].(string)
	deploymentMode, ok, errMsg := detectionTypeToDeploymentMode(detectionType)
	if !ok {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": errMsg})
		return
	}
	detectionTypeStored := detectionType
	if detectionTypeStored == "" {
		detectionTypeStored = "standard"
	}

	update := bson.M{
		"Rtsp_Link":      req["Rtsp_Link"],
		"Camera_Name":    newName,
		"Description":    req["Description"],
		"Feature":        req["Feature"],
		"Priority":       priority,
		"FPS":            fps,
		"Detection_Type": detectionTypeStored,
	}
	// Only overwrite boolean alert flags if the frontend explicitly sent them.
	// Node.js skips undefined fields; Go map lookups return nil for missing keys,
	// and MongoDB $set with nil writes null which reads back as false.
	for _, field := range []string{"Email_Auto_Alert", "Display_Auto_Alert", "Email_Alert", "Display_Alert"} {
		if v, ok := req[field]; ok && v != nil {
			update[field] = v
		}
	}
	_, err = coll.UpdateOne(ctx, bson.M{"_id": objID}, bson.M{"$set": update})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "unable to update camera"})
		return
	}

	// If name changed, update alerts and rename meta collection
	if newName != oldName {
		alertColl := db.GetCollection("Alerts")
		_, _ = alertColl.UpdateMany(ctx,
			bson.M{"Camera_Name": oldName},
			bson.M{"$set": bson.M{"Camera_Name": newName}})

		// Rename meta collection
		_ = db.DB.RunCommand(ctx, bson.D{
			{Key: "renameCollection", Value: db.DB.Name() + ".meta_" + oldName},
			{Key: "to", Value: db.DB.Name() + ".meta_" + newName},
		}).Err()
	}

	// Query alert names for this camera (same as Node.js serviceApiStartCamera)
	alertNames := getAlertNamesForCamera(ctx, newName)

	// Call service API with full payload including alerts
	cameraStartItem := map[string]interface{}{
		"rtsp_id":            req["rtsp_id"],
		"rtsp_link":          req["Rtsp_Link"],
		"camera_name":        oldName,
		"update_camera_name": newName,
		"prev_camera_name":   oldName,
		"alerts":             alertNames,
		"fps":                fps,
		"email_auto_alert":   req["Email_Auto_Alert"],
		"display_auto_alert": req["Display_Auto_Alert"],
		"email_alert":        req["Email_Alert"],
		"display_alert":      req["Display_Alert"],
	}
	if deploymentMode != "" {
		cameraStartItem["deployment_mode"] = deploymentMode
	}
	go callSurveillanceAPI(map[string]interface{}{
		"camera_list": []map[string]interface{}{cameraStartItem},
		"type":        "restart",
	})

	time.Sleep(4 * time.Second)
	c.JSON(http.StatusOK, gin.H{"success": true, "message": "camera update successful"})
}

func handleCameraDelete(c *gin.Context) {
	id := c.Param("id")
	objID, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid camera id"})
		return
	}
	ctx := context.Background()
	coll := db.GetCollection("config")

	// Find and delete
	var cam bson.M
	err = coll.FindOneAndDelete(ctx, bson.M{"_id": objID}).Decode(&cam)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, mongo.ErrNoDocuments) {
			status = http.StatusNotFound
		}
		c.JSON(status, gin.H{"success": false, "message": "unable to Inactive camera"})
		return
	}
	cameraName, _ := cam["Camera_Name"].(string)

	// Drop meta collection if exists
	collections, _ := db.DB.ListCollectionNames(ctx, bson.M{})
	for _, col := range collections {
		if col == "meta_"+cameraName {
			_ = db.GetCollection(col).Drop(ctx)
			break
		}
	}

	// Delete alerts
	alertColl := db.GetCollection("Alerts")
	_, _ = alertColl.DeleteMany(ctx, bson.M{"Camera_Name": cameraName})

	// Remove camera from groups
	groupColl := db.GetCollection("camera_groups")
	_, _ = groupColl.UpdateMany(ctx,
		bson.M{"cameras.camera_id": objID},
		bson.M{"$pull": bson.M{"cameras": bson.M{"camera_id": objID}}})
	_, _ = groupColl.DeleteMany(ctx, bson.M{"cameras": bson.M{"$size": 0}})

	// Stop surveillance
	go callSurveillanceAPI(map[string]interface{}{
		"camera_list": []map[string]interface{}{{
			"camera_name": cameraName, "rtsp_link": cam["Rtsp_Link"],
		}},
		"type": "stop",
	})

	c.JSON(http.StatusOK, gin.H{"success": true, "message": "camera Inactive successful"})
}

func handleCameraActivate(c *gin.Context) {
	id := c.Param("id")
	objID, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid camera id"})
		return
	}
	ctx := context.Background()
	coll := db.GetCollection("config")
	_, err = coll.UpdateOne(ctx, bson.M{"_id": objID}, bson.M{"$set": bson.M{"Active": true}})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "unable to Activation camera"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "message": "camera Activation successful"})
}

func handleToggleField(c *gin.Context, field string) {
	alertStr := c.Query("alert")
	isActive := alertStr == "true"
	ctx := context.Background()
	coll := db.GetCollection("config")
	_, err := coll.UpdateMany(ctx,
		bson.M{field: !isActive},
		bson.M{"$set": bson.M{field: isActive}})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "unable to update"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "message": "all " + field + " updated"})
}

func handleActiveEmailAutoAlert(c *gin.Context)  { handleToggleField(c, "Email_Auto_Alert") }
func handleActiveDisplayAutoAlert(c *gin.Context) { handleToggleField(c, "Display_Auto_Alert") }
func handleActiveEmailAlert(c *gin.Context)       { handleToggleField(c, "Email_Alert") }
func handleActiveDisplayAlert(c *gin.Context)     { handleToggleField(c, "Display_Alert") }

func handleEnableCamera(c *gin.Context) {
	live := c.Query("Live")
	cameraName := c.Query("Camera_Name")
	ctx := context.Background()
	coll := db.GetCollection("config")

	if live == "false" {
		// Pausing — find last frame timestamp
		dir := filepath.Join(config.Cfg.AkshaPath, cameraName, "frame")
		entries, _ := os.ReadDir(dir)
		var timestamps []string
		for _, e := range entries {
			name := strings.Replace(e.Name(), ".jpg", "", 1)
			name = strings.Replace(name, "_", ":", 1)
			name = strings.Replace(name, "_", ":", 1)
			timestamps = append(timestamps, name)
		}
		sort.Strings(timestamps)
		pausedTime := "null"
		if len(timestamps) > 0 {
			pausedTime = timestamps[len(timestamps)-1]
		}
		_, err := coll.UpdateOne(ctx, bson.M{"Camera_Name": cameraName},
			bson.M{"$set": bson.M{"Live": false, "PausedTime": pausedTime}})
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "unable to perform camera operation"})
			return
		}
	} else {
		_, err := coll.UpdateOne(ctx, bson.M{"Camera_Name": cameraName},
			bson.M{"$set": bson.M{"Live": true, "PausedTime": "null"}})
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "unable to perform camera operation"})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "message": "success to perform camera operation"})
}

func handleSurveillanceStatus(c *gin.Context) {
	status := c.Query("Surveillance_Status")
	cameraName := c.Query("Camera_Name")
	ctx := context.Background()
	coll := db.GetCollection("config")
	_, err := coll.UpdateOne(ctx, bson.M{"Camera_Name": cameraName},
		bson.M{"$set": bson.M{"Surveillance_Status": status}})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "unable to perform Surveillance operation"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "message": "success to perform Surveillance operation"})
}

func callSurveillanceAPI(params map[string]interface{}) {
	body, _ := json.Marshal(params)
	log.Printf("Surveillance API request: %s", string(body))
	url := fmt.Sprintf("http://%s:4000/Surveillance", config.Cfg.APIService)

	// Retry up to 5 times with 3s delay — API_SERVICE may still be booting.
	for attempt := 1; attempt <= 5; attempt++ {
		resp, err := http.Post(url, "application/json", bytes.NewReader(body))
		if err != nil {
			log.Printf("Surveillance API error (attempt %d/5): %v", attempt, err)
			time.Sleep(3 * time.Second)
			continue
		}
		defer resp.Body.Close()
		respBody, _ := io.ReadAll(resp.Body)
		log.Printf("Surveillance API response: %d %s", resp.StatusCode, string(respBody))
		return
	}
	log.Printf("Surveillance API: giving up after 5 attempts")
}

// getAlertNamesForCamera queries the Alerts collection for a given camera
// and returns a list of Alert_Name values. This mirrors the Node.js
// serviceApiStartCamera which sends alert names to the surveillance API.
func getAlertNamesForCamera(ctx context.Context, cameraName string) []string {
	alertColl := db.GetCollection("Alerts")
	cursor, err := alertColl.Find(ctx, bson.M{
		"Camera_Name": bson.M{"$in": bson.A{cameraName}},
	})
	if err != nil {
		log.Printf("getAlertNamesForCamera: %v", err)
		return []string{}
	}
	defer cursor.Close(ctx)

	var alertNames []string
	for cursor.Next(ctx) {
		var alert bson.M
		if err := cursor.Decode(&alert); err != nil {
			continue
		}
		if name, ok := alert["Alert_Name"].(string); ok {
			alertNames = append(alertNames, name)
		}
	}
	if alertNames == nil {
		alertNames = []string{}
	}
	return alertNames
}

// Suppress unused import warnings
var _ = mongo.ErrNoDocuments
