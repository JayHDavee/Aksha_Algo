// Package models defines MongoDB document structs.
// Migrated from: src/models/configSchema.js
package models

import "go.mongodb.org/mongo-driver/bson/primitive"

const ConfigCollection = "config"

// CameraConfig represents a camera configuration document.
type CameraConfig struct {
	ID                 primitive.ObjectID   `bson:"_id,omitempty" json:"_id"`
	RtspID             int                  `bson:"rtsp_id" json:"rtsp_id"`
	RtspLink           string               `bson:"Rtsp_Link" json:"Rtsp_Link"`
	CameraName         string               `bson:"Camera_Name" json:"Camera_Name"`
	Description        string               `bson:"Description,omitempty" json:"Description"`
	Feature            []string             `bson:"Feature" json:"Feature"`
	Priority           string               `bson:"Priority" json:"Priority"`
	Status             string               `bson:"Status" json:"Status"`
	EmailAutoAlert     bool                 `bson:"Email_Auto_Alert" json:"Email_Auto_Alert"`
	DisplayAutoAlert   bool                 `bson:"Display_Auto_Alert" json:"Display_Auto_Alert"`
	EmailAlert         bool                 `bson:"Email_Alert" json:"Email_Alert"`
	DisplayAlert       bool                 `bson:"Display_Alert" json:"Display_Alert"`
	FPS                float64              `bson:"FPS" json:"FPS"`
	Alerts             []primitive.ObjectID  `bson:"Alerts,omitempty" json:"Alerts"`
	Active             bool                 `bson:"Active" json:"Active"`
	Live               bool                 `bson:"Live" json:"Live"`
	SurveillanceStatus string               `bson:"Surveillance_Status" json:"Surveillance_Status"`
	PausedTime         string               `bson:"PausedTime" json:"PausedTime"`
	SkipInterval       interface{}          `bson:"Skip_Interval,omitempty" json:"Skip_Interval,omitempty"`
	GroupID            interface{}          `bson:"group_id,omitempty" json:"group_id,omitempty"`
}

// CameraConfigResponse is the API response shape for camera list.
type CameraConfigResponse struct {
	ID                 primitive.ObjectID `json:"_id"`
	RtspID             int                `json:"rtsp_id,omitempty"`
	RtspLink           string             `json:"Rtsp_Link"`
	CameraName         string             `json:"Camera_Name"`
	Description        string             `json:"Description"`
	Feature            []string           `json:"Feature"`
	Priority           string             `json:"Priority"`
	Status             string             `json:"Status"`
	EmailAutoAlert     bool               `json:"Email_Auto_Alert"`
	DisplayAutoAlert   bool               `json:"Display_Auto_Alert"`
	EmailAlert         bool               `json:"Email_Alert"`
	DisplayAlert       bool               `json:"Display_Alert"`
	SkipInterval       interface{}        `json:"Skip_Interval,omitempty"`
	Alert              []string           `json:"Alert,omitempty"`
	Image              string             `json:"image"`
	Active             bool               `json:"Active"`
}
