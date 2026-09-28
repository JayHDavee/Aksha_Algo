package routes

import (
	"context"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
	"github.com/algoanalytics-pvt/aksha-backend/internal/db"
)

func RegisterMyAlertRoutes(api *gin.RouterGroup) {
	api.POST(config.Cfg.CreateAlert, handleCreateAlert)
	api.PUT(config.Cfg.UpdateAlert, handleUpdateAlert)
	api.GET(config.Cfg.AlertByCameraName, handleAlertByCameraName)
	api.PUT(config.Cfg.DeleteAlert, handleDeleteAlert)
	api.GET(config.Cfg.FindCameraByAlertID, handleFindCameraByAlertID)
}

func handleCreateAlert(c *gin.Context) {
	var req map[string]interface{}
	if err := c.ShouldBindJSON(&req); err != nil {
		log.Printf("[AlertCreate] Failed to bind JSON: %v", err)
		log.Printf("[AlertCreate] Content-Type: %s", c.GetHeader("Content-Type"))
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}
	log.Printf("[AlertCreate] Received: %v", req)

	ctx := context.Background()
	alertColl := db.GetCollection("Alerts")

	req["Timestamp"] = time.Now().UTC().Format(time.RFC3339)
	result, err := alertColl.InsertOne(ctx, req)
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "E11000") || strings.Contains(msg, "duplicate key") {
			msg = "Alert name already exists. Please use a unique alert name."
		}
		log.Printf("[AlertCreate] Insert failed: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": msg})
		return
	}

	// Update camera configs to include the new alert ID
	cameraNames, _ := req["Camera_Name"].([]interface{})
	if len(cameraNames) > 0 {
		configColl := db.GetCollection("config")
		_, _ = configColl.UpdateMany(ctx,
			bson.M{"Camera_Name": bson.M{"$in": cameraNames}},
			bson.M{"$push": bson.M{"Alerts": result.InsertedID}})
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "message": "alert creation successful"})
}

func handleUpdateAlert(c *gin.Context) {
	id := c.Param("id")
	objID, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid id"})
		return
	}

	var req map[string]interface{}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}

	ctx := context.Background()
	alertColl := db.GetCollection("Alerts")
	_, err = alertColl.UpdateOne(ctx, bson.M{"_id": objID}, bson.M{"$set": req})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}

	// Push alert name to camera configs
	cameraNames, _ := req["Camera_Name"].([]interface{})
	alertName, _ := req["Alert_Name"].(string)
	if len(cameraNames) > 0 {
		configColl := db.GetCollection("config")
		_, _ = configColl.UpdateMany(ctx,
			bson.M{"Camera_Name": bson.M{"$in": cameraNames}},
			bson.M{"$push": bson.M{"Alert": alertName}})
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "message": "update alert successful"})
}

func handleAlertByCameraName(c *gin.Context) {
	cameraName := c.Param("camera_name")
	ctx := context.Background()
	alertColl := db.GetCollection("Alerts")
	cursor, err := alertColl.Find(ctx, bson.M{"Camera_Name": bson.M{"$in": []string{cameraName}}})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "unable to found alert"})
		return
	}
	var alerts []bson.M
	_ = cursor.All(ctx, &alerts)
	if alerts == nil {
		alerts = []bson.M{}
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "message": "alert list found", "alerts": alerts})
}

func handleDeleteAlert(c *gin.Context) {
	id := c.Param("id")
	objID, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid id"})
		return
	}

	var req struct {
		CameraName []string `json:"Camera_Name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}

	ctx := context.Background()
	alertColl := db.GetCollection("Alerts")

	// Find alert
	var alert bson.M
	err = alertColl.FindOne(ctx, bson.M{"_id": objID}).Decode(&alert)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}

	// Filter out the specified camera names
	existingNames, _ := alert["Camera_Name"].(primitive.A)
	var filtered []string
	for _, n := range existingNames {
		name, _ := n.(string)
		found := false
		for _, rn := range req.CameraName {
			if name == rn {
				found = true
				break
			}
		}
		if !found {
			filtered = append(filtered, name)
		}
	}

	// Pull alert from camera config
	configColl := db.GetCollection("config")
	_, _ = configColl.UpdateOne(ctx,
		bson.M{"Camera_Name": req.CameraName},
		bson.M{"$pull": bson.M{"Alerts": objID}})

	// If no cameras left, delete the alert
	if len(filtered) == 0 {
		_, _ = alertColl.DeleteOne(ctx, bson.M{"_id": objID})
	} else {
		_, _ = alertColl.UpdateOne(ctx, bson.M{"_id": objID},
			bson.M{"$set": bson.M{"Camera_Name": filtered}})
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "message": "delete alert successful"})
}

func handleFindCameraByAlertID(c *gin.Context) {
	id := c.Param("id")
	objID, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid id"})
		return
	}

	ctx := context.Background()
	alertColl := db.GetCollection("Alerts")
	var alert bson.M
	err = alertColl.FindOne(ctx, bson.M{"_id": objID}).Decode(&alert)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "message": "successfully found cameras", "CameraNames": alert["Camera_Name"]})
}
