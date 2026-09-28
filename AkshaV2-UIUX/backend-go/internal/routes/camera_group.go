// camera_group.go — Camera group CRUD endpoints
// Migrated from: src/routes/cameraGroup.js
//
// Endpoints:
//   POST   /api/camgroup/add  — create camera group
//   GET    /api/camgroup/     — list all groups
//   GET    /api/camgroup/:id  — get group details
//   PUT    /api/camgroup/:id  — update group
//   DELETE /api/camgroup/:id  — delete group + cleanup
package routes

import (
	"context"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo/options"

	"github.com/algoanalytics-pvt/aksha-backend/internal/db"
	"github.com/algoanalytics-pvt/aksha-backend/internal/models"
)

func RegisterCameraGroupRoutes(rg *gin.RouterGroup) {
	rg.POST("/add", handleCameraGroupCreate)
	rg.GET("/", handleCameraGroupList)
	rg.GET("/:id", handleCameraGroupGet)
	rg.PUT("/:id", handleCameraGroupUpdate)
	rg.DELETE("/:id", handleCameraGroupDelete)
}

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

type cameraGroupCreateRequest struct {
	GroupName    string                      `json:"group_name"`
	Description string                      `json:"description"`
	PriorityType string                     `json:"priority_type"`
	Cameras     []models.CameraGroupCamera  `json:"cameras"`
}

// ---------------------------------------------------------------------------
// POST /camgroup/add
// ---------------------------------------------------------------------------

func handleCameraGroupCreate(c *gin.Context) {
	var req cameraGroupCreateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "Missing required fields."})
		return
	}
	if req.GroupName == "" || req.Cameras == nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "Missing required fields."})
		return
	}

	ctx := context.Background()
	groupColl := db.GetCollection(models.CameraGroupCollection)
	configColl := db.GetCollection(models.ConfigCollection)

	// Check unique group name
	count, _ := groupColl.CountDocuments(ctx, bson.M{"group_name": req.GroupName})
	if count > 0 {
		c.JSON(http.StatusBadRequest, gin.H{"message": "Group name already exists."})
		return
	}

	// Check if any cameras already belong to a group
	cameraIDs := make([]primitive.ObjectID, len(req.Cameras))
	for i, cam := range req.Cameras {
		cameraIDs[i] = cam.CameraID
	}

	cursor, _ := groupColl.Find(ctx, bson.M{
		"cameras.camera_id": bson.M{"$in": cameraIDs},
	})
	var alreadyGrouped []models.CameraGroup
	_ = cursor.All(ctx, &alreadyGrouped)

	if len(alreadyGrouped) > 0 {
		var names []string
		for _, g := range alreadyGrouped {
			names = append(names, g.GroupName)
		}
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "Some cameras already assigned to another group.",
			"cameras": names,
		})
		return
	}

	// Create group
	doc := models.CameraGroup{
		GroupName:    req.GroupName,
		Description:  req.Description,
		PriorityType: req.PriorityType,
		Cameras:      req.Cameras,
	}
	result, err := groupColl.InsertOne(ctx, doc)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": "Error creating group", "error": err.Error()})
		return
	}

	// Update cameras with group_id = 1
	_, _ = configColl.UpdateMany(ctx,
		bson.M{"_id": bson.M{"$in": cameraIDs}},
		bson.M{"$set": bson.M{"group_id": 1}},
	)

	c.JSON(http.StatusCreated, gin.H{
		"success":  true,
		"message":  "Group created successfully",
		"group_id": result.InsertedID,
	})
}

// ---------------------------------------------------------------------------
// GET /camgroup/
// ---------------------------------------------------------------------------

func handleCameraGroupList(c *gin.Context) {
	ctx := context.Background()
	groupColl := db.GetCollection(models.CameraGroupCollection)

	cursor, err := groupColl.Find(ctx, bson.M{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": "Error fetching groups", "error": err.Error()})
		return
	}
	var groups []bson.M
	_ = cursor.All(ctx, &groups)
	if groups == nil {
		groups = []bson.M{}
	}

	c.JSON(http.StatusOK, gin.H{"groups": groups})
}

// ---------------------------------------------------------------------------
// GET /camgroup/:id
// ---------------------------------------------------------------------------

func handleCameraGroupGet(c *gin.Context) {
	id := c.Param("id")
	objID, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "Invalid group id"})
		return
	}

	ctx := context.Background()
	groupColl := db.GetCollection(models.CameraGroupCollection)
	configColl := db.GetCollection(models.ConfigCollection)

	var group models.CameraGroup
	err = groupColl.FindOne(ctx, bson.M{"_id": objID}).Decode(&group)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"message": "Group not found"})
		return
	}

	// Fetch camera details
	cameraIDs := make([]primitive.ObjectID, len(group.Cameras))
	for i, cam := range group.Cameras {
		cameraIDs[i] = cam.CameraID
	}

	projection := options.Find().SetProjection(bson.M{"Camera_Name": 1, "Rtsp_Link": 1})
	cursor, err := configColl.Find(ctx, bson.M{"_id": bson.M{"$in": cameraIDs}}, projection)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": "Error fetching camera details", "error": err.Error()})
		return
	}
	var cameraData []bson.M
	_ = cursor.All(ctx, &cameraData)

	// Build camera response matching each group camera with its config data
	type cameraResponse struct {
		CameraID   primitive.ObjectID `json:"camera_id"`
		CameraName string             `json:"camera_name"`
		RtspLink   string             `json:"rtsp_link"`
	}
	cameras := make([]cameraResponse, 0, len(group.Cameras))
	for _, gc := range group.Cameras {
		name := gc.CameraName
		rtsp := ""
		for _, cd := range cameraData {
			cdID, _ := cd["_id"].(primitive.ObjectID)
			if cdID == gc.CameraID {
				if n, ok := cd["Camera_Name"].(string); ok {
					name = n
				}
				if r, ok := cd["Rtsp_Link"].(string); ok {
					rtsp = r
				}
				break
			}
		}
		cameras = append(cameras, cameraResponse{
			CameraID:   gc.CameraID,
			CameraName: name,
			RtspLink:   rtsp,
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"success":       true,
		"group_name":    group.GroupName,
		"description":   group.Description,
		"priority_type": group.PriorityType,
		"cameras":       cameras,
	})
}

// ---------------------------------------------------------------------------
// PUT /camgroup/:id
// ---------------------------------------------------------------------------

func handleCameraGroupUpdate(c *gin.Context) {
	id := c.Param("id")
	objID, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "Invalid group id"})
		return
	}

	var req cameraGroupCreateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "Invalid request body"})
		return
	}

	ctx := context.Background()
	groupColl := db.GetCollection(models.CameraGroupCollection)
	configColl := db.GetCollection(models.ConfigCollection)

	// Find existing group
	var group models.CameraGroup
	err = groupColl.FindOne(ctx, bson.M{"_id": objID}).Decode(&group)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"message": "Group not found"})
		return
	}

	// Build old and new camera ID sets
	oldCameraIDs := make(map[string]bool)
	for _, cam := range group.Cameras {
		oldCameraIDs[cam.CameraID.Hex()] = true
	}

	newCameraIDs := make(map[string]bool)
	for _, cam := range req.Cameras {
		newCameraIDs[cam.CameraID.Hex()] = true
	}

	// Determine newly added cameras (not in old group)
	var newlyAdded []primitive.ObjectID
	for _, cam := range req.Cameras {
		if !oldCameraIDs[cam.CameraID.Hex()] {
			newlyAdded = append(newlyAdded, cam.CameraID)
		}
	}

	// Check conflicts: newly added cameras that already have group_id=1 in another group
	if len(newlyAdded) > 0 {
		cursor, _ := configColl.Find(ctx, bson.M{
			"_id":      bson.M{"$in": newlyAdded},
			"group_id": 1,
		})
		var conflicts []bson.M
		_ = cursor.All(ctx, &conflicts)

		if len(conflicts) > 0 {
			var names []string
			for _, cf := range conflicts {
				if n, ok := cf["Camera_Name"].(string); ok {
					names = append(names, n)
				}
			}
			c.JSON(http.StatusBadRequest, gin.H{
				"message": "Some cameras already assigned to another group.",
				"cameras": names,
			})
			return
		}
	}

	// Unassign cameras removed from the group
	var removedIDs []primitive.ObjectID
	for _, cam := range group.Cameras {
		if !newCameraIDs[cam.CameraID.Hex()] {
			removedIDs = append(removedIDs, cam.CameraID)
		}
	}
	if len(removedIDs) > 0 {
		_, _ = configColl.UpdateMany(ctx,
			bson.M{"_id": bson.M{"$in": removedIDs}},
			bson.M{"$unset": bson.M{"group_id": ""}},
		)
	}

	// Update group document
	_, err = groupColl.UpdateOne(ctx,
		bson.M{"_id": objID},
		bson.M{"$set": bson.M{
			"group_name":    req.GroupName,
			"description":   req.Description,
			"priority_type": req.PriorityType,
			"cameras":       req.Cameras,
		}},
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": "Error updating group", "error": err.Error()})
		return
	}

	// Assign group_id to newly added cameras
	if len(newlyAdded) > 0 {
		_, _ = configColl.UpdateMany(ctx,
			bson.M{"_id": bson.M{"$in": newlyAdded}},
			bson.M{"$set": bson.M{"group_id": 1}},
		)
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "Group updated successfully",
	})
}

// ---------------------------------------------------------------------------
// DELETE /camgroup/:id
// ---------------------------------------------------------------------------

func handleCameraGroupDelete(c *gin.Context) {
	id := c.Param("id")
	objID, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "Invalid group id"})
		return
	}

	ctx := context.Background()
	groupColl := db.GetCollection(models.CameraGroupCollection)
	configColl := db.GetCollection(models.ConfigCollection)
	notifColl := db.GetCollection(models.CameraNotificationManagerCollection)

	// Find group
	var group models.CameraGroup
	err = groupColl.FindOne(ctx, bson.M{"_id": objID}).Decode(&group)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"message": "Group not found"})
		return
	}

	// Collect camera IDs
	var cameraIDs []primitive.ObjectID
	for _, cam := range group.Cameras {
		cameraIDs = append(cameraIDs, cam.CameraID)
	}

	// Unassign cameras from group
	if len(cameraIDs) > 0 {
		_, _ = configColl.UpdateMany(ctx,
			bson.M{"_id": bson.M{"$in": cameraIDs}},
			bson.M{"$unset": bson.M{"group_id": ""}},
		)
	}

	// Delete notification config linked to this group
	delResult, err := notifColl.DeleteMany(ctx, bson.M{"camera_group_id": objID})
	if err != nil {
		log.Printf("Delete notification config error: %v", err)
	} else {
		log.Printf("Deleted %d notification configs for group %s", delResult.DeletedCount, id)
	}

	// Delete the group itself
	_, err = groupColl.DeleteOne(ctx, bson.M{"_id": objID})
	if err != nil {
		log.Printf("Delete group error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"message": "Error deleting group", "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "Group and related notifications deleted successfully",
	})
}
