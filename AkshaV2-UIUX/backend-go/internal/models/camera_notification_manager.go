package models

import (
	"time"
	"go.mongodb.org/mongo-driver/bson/primitive"
)

const CameraNotificationManagerCollection = "camera_notification_managers"

type EmailConfig struct {
	Enabled   bool   `bson:"enabled" json:"enabled"`
	EmailList string `bson:"email_list" json:"email_list"`
}

type MobileConfig struct {
	Enabled       bool   `bson:"enabled" json:"enabled"`
	MobileNumbers string `bson:"mobile_numbers" json:"mobile_numbers"`
}

type TelegramConfig struct {
	Enabled  bool   `bson:"enabled" json:"enabled"`
	BotToken string `bson:"bot_token" json:"bot_token"`
	ChatID   string `bson:"chat_id" json:"chat_id"`
}

type CameraNotificationManager struct {
	ID            primitive.ObjectID `bson:"_id,omitempty" json:"_id"`
	CameraGroupID primitive.ObjectID `bson:"camera_group_id" json:"camera_group_id"`
	Email         EmailConfig        `bson:"email" json:"email"`
	Mobile        MobileConfig       `bson:"mobile" json:"mobile"`
	Telegram      TelegramConfig     `bson:"telegram" json:"telegram"`
	AlertsEnabled bool               `bson:"alerts_enabled" json:"alerts_enabled"`
	CreatedAt     time.Time          `bson:"created_at,omitempty" json:"created_at"`
	UpdatedAt     time.Time          `bson:"updated_at,omitempty" json:"updated_at"`
}
