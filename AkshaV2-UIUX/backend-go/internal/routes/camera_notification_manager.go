// camera_notification_manager.go — Per-group notification config endpoints
// Migrated from: src/routes/cameraNotificationManager.js
//
// Endpoints:
//   POST   /api/notification/add                          — create config
//   GET    /api/notification/                             — list all configs
//   GET    /api/notification/group/:groupId               — get config by group
//   PUT    /api/notification/:id                          — update config
//   PUT    /api/notification/toggle/group/:groupId/:ch    — toggle channel for group
//   PUT    /api/notification/toggle/group/:groupId        — toggle all for group
//   PUT    /api/notification/toggle/all                   — toggle all globally
//   PUT    /api/notification/toggle/all/:channel          — toggle channel globally
//   DELETE /api/notification/:id                          — delete config
package routes

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"

	"github.com/algoanalytics-pvt/aksha-backend/internal/db"
	"github.com/algoanalytics-pvt/aksha-backend/internal/models"
)

// RegisterCameraNotificationManagerRoutes mounts notification-config CRUD and
// toggle endpoints onto the supplied router group.
func RegisterCameraNotificationManagerRoutes(rg *gin.RouterGroup) {
	rg.POST("/add", handleCreateNotificationConfig)
	rg.GET("/", handleListNotificationConfigs)
	rg.GET("/group/:groupId", handleGetNotificationConfigByGroup)
	rg.PUT("/:id", handleUpdateNotificationConfig)
	rg.PUT("/toggle/group/:groupId/:channel", handleToggleChannelForGroup)
	rg.PUT("/toggle/group/:groupId", handleToggleAllForGroup)
	rg.PUT("/toggle/all", handleToggleAllGlobally)
	rg.PUT("/toggle/all/:channel", handleToggleChannelGlobally)
	rg.DELETE("/:id", handleDeleteNotificationConfig)
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

func notifColl() *mongo.Collection {
	return db.GetCollection(models.CameraNotificationManagerCollection)
}

func groupColl() *mongo.Collection {
	return db.GetCollection(models.CameraGroupCollection)
}

var validChannels = map[string]bool{
	"email":    true,
	"mobile":   true,
	"telegram": true,
}

// ---------------------------------------------------------------------------
//  CREATE
// ---------------------------------------------------------------------------

type createNotifRequest struct {
	CameraGroupID string                `json:"camera_group_id"`
	Email         *models.EmailConfig   `json:"email,omitempty"`
	Mobile        *models.MobileConfig  `json:"mobile,omitempty"`
	Telegram      *models.TelegramConfig `json:"telegram,omitempty"`
	AlertsEnabled *bool                 `json:"alerts_enabled,omitempty"`
}

func handleCreateNotificationConfig(c *gin.Context) {
	var req createNotifRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "invalid request body"})
		return
	}

	if req.CameraGroupID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"message": "camera_group_id required"})
		return
	}

	groupOID, err := primitive.ObjectIDFromHex(req.CameraGroupID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "invalid camera_group_id"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Verify the camera group exists.
	var group bson.M
	if err := groupColl().FindOne(ctx, bson.M{"_id": groupOID}).Decode(&group); err != nil {
		if err == mongo.ErrNoDocuments {
			c.JSON(http.StatusNotFound, gin.H{"message": "Camera group not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}

	// Check for existing config for this group.
	count, err := notifColl().CountDocuments(ctx, bson.M{"camera_group_id": groupOID})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}
	if count > 0 {
		c.JSON(http.StatusBadRequest, gin.H{"message": "Notification config already exists"})
		return
	}

	// Build the document with defaults matching the Mongoose schema.
	now := time.Now()
	doc := models.CameraNotificationManager{
		CameraGroupID: groupOID,
		Email:         models.EmailConfig{Enabled: true},
		Mobile:        models.MobileConfig{Enabled: true},
		Telegram:      models.TelegramConfig{Enabled: false},
		AlertsEnabled: true,
		CreatedAt:     now,
		UpdatedAt:     now,
	}

	// Override defaults with provided values.
	if req.Email != nil {
		doc.Email = *req.Email
	}
	if req.Mobile != nil {
		doc.Mobile = *req.Mobile
	}
	if req.Telegram != nil {
		doc.Telegram = *req.Telegram
	}
	if req.AlertsEnabled != nil {
		doc.AlertsEnabled = *req.AlertsEnabled
	}

	result, err := notifColl().InsertOne(ctx, doc)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"success": true, "id": result.InsertedID})
}

// ---------------------------------------------------------------------------
//  GET ALL (with populate)
// ---------------------------------------------------------------------------

func handleListNotificationConfigs(c *gin.Context) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Use an aggregation pipeline to $lookup camera_groups (equivalent to
	// Mongoose .populate("camera_group_id", "group_name priority_type")).
	pipeline := mongo.Pipeline{
		{{Key: "$lookup", Value: bson.M{
			"from":         models.CameraGroupCollection,
			"localField":   "camera_group_id",
			"foreignField": "_id",
			"as":           "camera_group_info",
		}}},
		{{Key: "$unwind", Value: bson.M{
			"path":                       "$camera_group_info",
			"preserveNullAndEmptyArrays": true,
		}}},
		{{Key: "$addFields", Value: bson.M{
			"camera_group_id": bson.M{
				"_id":           "$camera_group_info._id",
				"group_name":    "$camera_group_info.group_name",
				"priority_type": "$camera_group_info.priority_type",
			},
		}}},
		{{Key: "$project", Value: bson.M{
			"camera_group_info": 0,
		}}},
	}

	cursor, err := notifColl().Aggregate(ctx, pipeline)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}
	defer cursor.Close(ctx)

	var data []bson.M
	if err := cursor.All(ctx, &data); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}
	if data == nil {
		data = []bson.M{}
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
}

// ---------------------------------------------------------------------------
//  GET BY GROUP
// ---------------------------------------------------------------------------

func handleGetNotificationConfigByGroup(c *gin.Context) {
	groupID := c.Param("groupId")

	oid, err := primitive.ObjectIDFromHex(groupID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "Invalid group ID"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var config models.CameraNotificationManager
	err = notifColl().FindOne(ctx, bson.M{"camera_group_id": oid}).Decode(&config)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			c.JSON(http.StatusNotFound, gin.H{"message": "Notification manager not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "config": config})
}

// ---------------------------------------------------------------------------
//  UPDATE
// ---------------------------------------------------------------------------

func handleUpdateNotificationConfig(c *gin.Context) {
	id := c.Param("id")

	oid, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "Invalid ID"})
		return
	}

	var body bson.M
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "invalid request body"})
		return
	}

	// Strip immutable fields — MongoDB rejects $set on _id
	delete(body, "_id")
	delete(body, "camera_group_id")
	body["updated_at"] = time.Now()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	result := notifColl().FindOneAndUpdate(
		ctx,
		bson.M{"_id": oid},
		bson.M{"$set": body},
		options.FindOneAndUpdate().SetReturnDocument(options.After),
	)
	if result.Err() != nil {
		if result.Err() == mongo.ErrNoDocuments {
			c.JSON(http.StatusNotFound, gin.H{"message": "Notification manager not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"message": result.Err().Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "message": "Updated successfully"})
}

// ---------------------------------------------------------------------------
//  TOGGLE — SINGLE GROUP, SINGLE CHANNEL
// ---------------------------------------------------------------------------

func handleToggleChannelForGroup(c *gin.Context) {
	groupID := c.Param("groupId")
	channel := c.Param("channel")

	if !validChannels[channel] {
		c.JSON(http.StatusBadRequest, gin.H{"message": "Invalid channel"})
		return
	}

	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "invalid request body"})
		return
	}

	groupOID, err := primitive.ObjectIDFromHex(groupID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "Invalid group ID"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err = notifColl().UpdateOne(
		ctx,
		bson.M{"camera_group_id": groupOID},
		bson.M{"$set": bson.M{
			fmt.Sprintf("%s.enabled", channel): body.Enabled,
			"updated_at":                       time.Now(),
		}},
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}

	status := "disabled"
	if body.Enabled {
		status = "enabled"
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": fmt.Sprintf("%s %s for group", channel, status),
	})
}

// ---------------------------------------------------------------------------
//  TOGGLE — SINGLE GROUP, ALL CHANNELS (master switch)
// ---------------------------------------------------------------------------

func handleToggleAllForGroup(c *gin.Context) {
	groupID := c.Param("groupId")

	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "invalid request body"})
		return
	}

	groupOID, err := primitive.ObjectIDFromHex(groupID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "Invalid group ID"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err = notifColl().UpdateOne(
		ctx,
		bson.M{"camera_group_id": groupOID},
		bson.M{"$set": bson.M{
			"alerts_enabled": body.Enabled,
			"updated_at":     time.Now(),
		}},
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}

	status := "disabled"
	if body.Enabled {
		status = "enabled"
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": fmt.Sprintf("Notifications %s for group", status),
	})
}

// ---------------------------------------------------------------------------
//  GLOBAL TOGGLE — ALL GROUPS (master switch)
// ---------------------------------------------------------------------------

func handleToggleAllGlobally(c *gin.Context) {
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "invalid request body"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := notifColl().UpdateMany(
		ctx,
		bson.M{},
		bson.M{"$set": bson.M{
			"alerts_enabled": body.Enabled,
			"updated_at":     time.Now(),
		}},
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}

	status := "disabled"
	if body.Enabled {
		status = "enabled"
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": fmt.Sprintf("Notifications %s for ALL groups", status),
	})
}

// ---------------------------------------------------------------------------
//  GLOBAL TOGGLE — ALL GROUPS, SINGLE CHANNEL
// ---------------------------------------------------------------------------

func handleToggleChannelGlobally(c *gin.Context) {
	channel := c.Param("channel")

	if !validChannels[channel] {
		c.JSON(http.StatusBadRequest, gin.H{"message": "Invalid channel"})
		return
	}

	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "invalid request body"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := notifColl().UpdateMany(
		ctx,
		bson.M{},
		bson.M{"$set": bson.M{
			fmt.Sprintf("%s.enabled", channel): body.Enabled,
			"updated_at":                       time.Now(),
		}},
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}

	status := "disabled"
	if body.Enabled {
		status = "enabled"
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": fmt.Sprintf("%s %s for ALL groups", channel, status),
	})
}

// ---------------------------------------------------------------------------
//  DELETE
// ---------------------------------------------------------------------------

func handleDeleteNotificationConfig(c *gin.Context) {
	id := c.Param("id")

	oid, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "Invalid ID"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	result, err := notifColl().DeleteOne(ctx, bson.M{"_id": oid})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}
	if result.DeletedCount == 0 {
		c.JSON(http.StatusNotFound, gin.H{"message": "Notification manager not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "message": "Deleted successfully"})
}
