package routes

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
)

func RegisterDaysRoutes(api *gin.RouterGroup) {
	api.GET(config.Cfg.Days, handleDays)
}

func handleDays(c *gin.Context) {
	workday := c.Query("workday")
	if workday == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "please provide proper data"})
		return
	}

	data := map[string]string{"workday": workday}
	jsonData, _ := json.Marshal(data)
	filePath := filepath.Join(config.Cfg.AkshaPath, "global.json")
	if err := os.WriteFile(filePath, jsonData, 0644); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "message": "response has been submitted"})
}
