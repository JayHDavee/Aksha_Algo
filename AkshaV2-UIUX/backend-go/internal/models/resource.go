package models

import "go.mongodb.org/mongo-driver/bson/primitive"

const ResourceCollection = "Resource"

type Resource struct {
	ID                primitive.ObjectID `bson:"_id,omitempty" json:"_id"`
	NotificationEmail []string           `bson:"notification_email" json:"notification_email"`
	Username          string             `bson:"username" json:"username"`
	NewEmail          string             `bson:"new_email" json:"new_email"`
	BotToken          string             `bson:"bot_token" json:"bot_token"`
	ChatIDs           []string           `bson:"chat_ids" json:"chat_ids"`
	SendAlertReport   bool               `bson:"send_alert_report" json:"send_alert_report"`
	AlertReportEmail  []string           `bson:"alert_report_email" json:"alert_report_email"`
	GenAIFeatures     bool               `bson:"genai_features" json:"genai_features"`
}
