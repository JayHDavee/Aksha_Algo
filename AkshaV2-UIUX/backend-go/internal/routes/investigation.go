package routes

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/bson"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
	"github.com/algoanalytics-pvt/aksha-backend/internal/db"
)

func RegisterInvestigationRoutes(api *gin.RouterGroup) {
	api.GET(config.Cfg.CameraNames, handleCameraNames)
	api.GET(config.Cfg.ObjectOfInterestLabels, handleObjectLabels)
	api.GET(config.Cfg.ReferenceImage, handleReferenceImage)
}

func handleCameraNames(c *gin.Context) {
	ctx := c.Request.Context()
	coll := db.GetCollection("config")
	cursor, err := coll.Find(ctx, bson.M{})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error(), "cameras": []interface{}{}})
		return
	}
	var cameras []bson.M
	_ = cursor.All(ctx, &cameras)
	if cameras == nil {
		cameras = []bson.M{}
	}

	// Add reference image URLs (images are saved by rtsp_id, e.g. 1.jpg, 2.jpg)
	baseURL := config.Cfg.BaseURL()
	for i, info := range cameras {
		rtspID := fmt.Sprintf("%v", info["rtsp_id"])
		imgPath := filepath.Join(config.Cfg.AkshaPath, "Reference_images", rtspID+".jpg")
		imageURL := ""
		if _, err := os.Stat(imgPath); err == nil {
			imageURL = fmt.Sprintf("%s/Reference_images/%s.jpg", baseURL, rtspID)
		}
		cameras[i]["image"] = imageURL
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "message": "Fetch All Camera Name Successfully", "cameras": cameras})
}

func handleObjectLabels(c *gin.Context) {
	labelsPath := filepath.Join(config.Cfg.AkshaPath, "labels.txt")
	data, err := os.ReadFile(labelsPath)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error(), "labels": []string{}})
		return
	}
	labels := strings.Split(strings.TrimSpace(string(data)), "\n")
	c.JSON(http.StatusOK, gin.H{"success": true, "message": "Fetch All Labels Successfully", "labels": labels})
}

func handleReferenceImage(c *gin.Context) {
	cam := c.Param("camera_name")
	rtspPath := filepath.Join(config.Cfg.AkshaPath, "rtsplinks.json")
	data, err := os.ReadFile(rtspPath)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error(), "image": nil})
		return
	}
	var rtspData map[string]map[string]interface{}
	if err := json.Unmarshal(data, &rtspData); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error(), "image": nil})
		return
	}

	baseURL := config.Cfg.BaseURL()
	for _, v := range rtspData {
		camName, _ := v["cam_name"].(string)
		if camName == cam {
			rtspID := fmt.Sprintf("%v", v["rtsp_id"])
			imgPath := filepath.Join(config.Cfg.AkshaPath, "Reference_images", rtspID+".jpg")
			if _, err := os.Stat(imgPath); err == nil {
				c.Header("Cross-Origin-Resource-Policy", "same-site")
				c.JSON(http.StatusOK, gin.H{
					"success": true, "message": "Fetch Reference Image Successfully",
					"image": fmt.Sprintf("%s/Reference_images/%s.jpg", baseURL, rtspID),
				})
				return
			}
			c.JSON(http.StatusOK, gin.H{"success": true, "message": "Fetch Reference Image Successfully", "image": nil})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "message": "Fetch Reference Image Successfully", "image": nil})
}
