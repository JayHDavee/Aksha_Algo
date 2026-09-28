// active_camera.go — Live and spotlight camera list endpoints
// Migrated from: src/routes/activeCamera.js
//
// Endpoints:
//   GET /api/active/getLiveCamera      — list cameras with live feed URLs
//   GET /api/active/getSpotlightCamera — list cameras with spotlight images
package routes

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/algoanalytics-pvt/aksha-backend/internal/functions"
)

func RegisterActiveCameraRoutes(rg *gin.RouterGroup) {
	rg.GET("/getLiveCamera", handleGetLiveCamera)
	rg.GET("/getSpotlightCamera", handleGetSpotlightCamera)
}

func handleGetLiveCamera(c *gin.Context) {
	cameraDetail, err := functions.ListLiveCamera()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"success": false,
			"message": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "initial live camera details",
		"info":    cameraDetail,
	})
}

func handleGetSpotlightCamera(c *gin.Context) {
	cameraDetail, err := functions.ListSpotlightCameras()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"success": false,
			"message": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "initial camera spotlight details",
		"info":    cameraDetail,
	})
}
