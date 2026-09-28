// notification.go — Global notification settings endpoints
// Migrated from: src/routes/notification.js
//
// Endpoints:
//   PUT /api/notification/update — update email/telegram notification config
//   GET /api/notification        — get current notification settings
package routes

import (
	"context"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/bson"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
	"github.com/algoanalytics-pvt/aksha-backend/internal/db"
	"github.com/algoanalytics-pvt/aksha-backend/internal/models"
)

func RegisterNotificationRoutes(rg *gin.RouterGroup) {
	rg.PUT(config.Cfg.EmailNotificationUpdate, handleNotificationUpdate)
	rg.GET(config.Cfg.EmailNotification, handleNotificationGet)
}

type notificationUpdateRequest struct {
	Username          string   `json:"Username"`
	NewEmail          string   `json:"New_Email"`
	NotificationEmail []string `json:"Notification_Email"`
	AlertReportEmails []string `json:"Alert_Report_Emails"`
	BotToken          string   `json:"Bot_token"`
	ChatIDs           []string `json:"Chat_ids"`
	GenAIFeatures     bool     `json:"Gen_AI_features"`
}

func handleNotificationUpdate(c *gin.Context) {
	var req notificationUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid request body"})
		return
	}

	if len(req.NotificationEmail) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{
			"success": false,
			"message": "please provide proper data!",
		})
		return
	}

	ctx := context.Background()
	coll := db.GetCollection(models.ResourceCollection)

	updateFields := bson.M{
		"notification_email": req.NotificationEmail,
		"alert_report_email": req.AlertReportEmails,
		"username":           req.Username,
		"new_email":          req.NewEmail,
		"bot_token":          req.BotToken,
		"chat_ids":           req.ChatIDs,
		"genai_features":     req.GenAIFeatures,
	}

	// Try to find an existing document
	var existing bson.M
	err := coll.FindOne(ctx, bson.M{}).Decode(&existing)
	if err != nil {
		// No document exists — create one
		_, insertErr := coll.InsertOne(ctx, updateFields)
		if insertErr != nil {
			log.Printf("notification insert error: %v", insertErr)
			c.JSON(http.StatusBadRequest, gin.H{
				"success": false,
				"message": insertErr.Error(),
			})
			return
		}
	} else {
		// Update existing document
		_, updateErr := coll.UpdateOne(ctx, bson.M{}, bson.M{"$set": updateFields})
		if updateErr != nil {
			log.Printf("notification update error: %v", updateErr)
			c.JSON(http.StatusBadRequest, gin.H{
				"success": false,
				"message": updateErr.Error(),
			})
			return
		}
	}

	// Fire-and-forget: notify API_SERVICE to reload notification config
	go func() {
		resp, err := http.Post("http://API_SERVICE:4000/Notifications", "application/json", nil)
		if err != nil {
			log.Printf("Could not restart cameras: %v", err)
			return
		}
		resp.Body.Close()
	}()

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "Email Updated Successfully ",
	})
}

func handleNotificationGet(c *gin.Context) {
	ctx := context.Background()
	coll := db.GetCollection(models.ResourceCollection)

	var doc models.Resource
	err := coll.FindOne(ctx, bson.M{}).Decode(&doc)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"success": false,
			"message": "unable to fetch notification settings",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success":            true,
		"notification_email": doc.NotificationEmail,
		"alert_report_email": doc.AlertReportEmail,
		"bot_token":          doc.BotToken,
		"chat_ids":           doc.ChatIDs,
		"new_email":          doc.NewEmail,
		"genai_features":     doc.GenAIFeatures,
	})
}
