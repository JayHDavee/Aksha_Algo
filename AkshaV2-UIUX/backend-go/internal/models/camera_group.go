package models

import (
	"time"
	"go.mongodb.org/mongo-driver/bson/primitive"
)

const CameraGroupCollection = "camera_groups"

type CameraGroupCamera struct {
	CameraID    primitive.ObjectID `bson:"camera_id" json:"camera_id"`
	CameraName  string             `bson:"camera_name" json:"camera_name"`
	CustomOrder int                `bson:"custom_order" json:"custom_order"`
}

type CameraGroup struct {
	ID           primitive.ObjectID   `bson:"_id,omitempty" json:"_id"`
	GroupName    string               `bson:"group_name" json:"group_name"`
	Description  string               `bson:"description" json:"description"`
	PriorityType string               `bson:"priority_type" json:"priority_type"`
	Cameras      []CameraGroupCamera  `bson:"cameras" json:"cameras"`
	CreatedAt    time.Time            `bson:"created_at,omitempty" json:"created_at"`
	UpdatedAt    time.Time            `bson:"updated_at,omitempty" json:"updated_at"`
}
