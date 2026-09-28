package models

import (
	"time"
	"go.mongodb.org/mongo-driver/bson/primitive"
)

const AlertCollection = "Alerts"

type Alert struct {
	ID                primitive.ObjectID `bson:"_id,omitempty" json:"_id"`
	AlertName         string             `bson:"Alert_Name" json:"Alert_Name"`
	NoObjectStatus    bool               `bson:"No_Object_Status" json:"No_Object_Status"`
	ObjectClass       string             `bson:"Object_Class" json:"Object_Class"`
	ObjectArea        [][]float64        `bson:"Object_Area" json:"Object_Area"`
	StartTime         string             `bson:"Start_Time" json:"Start_Time"`
	EndTime           string             `bson:"End_Time" json:"End_Time"`
	DaysActive        []string           `bson:"Days_Active" json:"Days_Active"`
	HolidayStatus     bool               `bson:"Holiday_Status" json:"Holiday_Status"`
	WorkdayStatus     bool               `bson:"Workday_Status" json:"Workday_Status"`
	AlertStatus       string             `bson:"Alert_Status" json:"Alert_Status"`
	DisplayActivation bool               `bson:"Display_Activation" json:"Display_Activation"`
	EmailActivation   bool               `bson:"Email_Activation" json:"Email_Activation"`
	Timestamp         string             `bson:"Timestamp,omitempty" json:"Timestamp"`
	CameraName        []string           `bson:"Camera_Name" json:"Camera_Name"`
	AlertDescription  string             `bson:"Alert_Description,omitempty" json:"Alert_Description"`
}

func (a *Alert) SetTimestamp() {
	a.Timestamp = time.Now().UTC().Format(time.RFC3339)
}
