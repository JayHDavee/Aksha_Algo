// Package config loads environment variables and application configuration.
// Migrated from: config.js + .env files
package config

import (
	"fmt"
	"os"

	"github.com/joho/godotenv"
)

// Config holds all application configuration.
type Config struct {
	Port       string
	Database   string
	AkshaPath  string
	JWTSecret  string
	APIService string
	Protocol   string
	Host       string

	// Route path mappings (previously process.env.*)
	CameraCreate          string
	CameraList            string
	CameraLimit           string
	UpdateCamera          string
	DeleteCamera          string
	ActivateCamera        string
	ActiveEmailAutoAlert  string
	ActiveDisplayAutoAlert string
	ActiveEmailAlert      string
	ActiveDisplayAlert    string
	EnableCamera          string
	SurveillanceStatus    string
	FeatureFlags          string

	// Feature flags — mirror the Node backend's PPE_DETECTION/JEWELRY_DETECTION
	// env vars exactly (same names, same "true" string check), so either
	// backend reports the same flag state regardless of which one is deployed.
	PPEDetection     bool
	JewelryDetection bool

	MyAlert            string
	AutoAlert          string
	UserFeedback       string
	RecentAlert        string
	ObjectOfInterest   string

	CreateAlert          string
	UpdateAlert          string
	AlertByCameraName    string
	DeleteAlert          string
	FindCameraByAlertID  string

	CameraNames           string
	ObjectOfInterestLabels string
	ReferenceImage        string

	Insight       string
	InsightReport string
	MailInsightReportStatus string
	MailInsightReport       string

	Days string

	EmailNotificationUpdate string
	EmailNotification       string

	KPIReport string
}

// Cfg is the global configuration instance.
var Cfg Config

// Init loads the .env file and populates the Cfg struct.
// Mirrors the Node.js pattern: loads .env.{GO_ENV} first (like NODE_ENV),
// then falls back to .env if the env-specific file doesn't exist.
func Init() error {
	env := os.Getenv("GO_ENV")
	if env == "" {
		env = os.Getenv("NODE_ENV")
	}

	// Try env-specific file first (e.g. .env.production), then default .env.
	// Look in both the current directory and the project root (for when
	// running from cmd/server/).
	candidates := []string{".env"}
	if env != "" {
		candidates = append([]string{fmt.Sprintf(".env.%s", env)}, candidates...)
	}
	for _, name := range candidates {
		_ = godotenv.Load(name)           // current dir
		_ = godotenv.Load("../../" + name) // project root from cmd/server/
	}

	Cfg = Config{
		Port:       getEnv("PORT", "5000"),
		Database:   getEnv("DATABASE", ""),
		AkshaPath:  getEnv("AKSHA_PATH", ""),
		JWTSecret:  getEnv("JWT_SECRET", "akshajwt"),
		APIService: getEnv("API_SERVICE", "API_SERVICE"),
		Protocol:   getEnv("PROTOCOL", "http"),
		Host:       getEnv("HOST", "localhost"),

		CameraCreate:           getEnv("CAMERA_CREATE", "/camera/create"),
		CameraList:             getEnv("CAMERA_LIST", "/camera"),
		CameraLimit:            getEnv("CAMERA_LIMIT", "/camera/limit"),
		UpdateCamera:           getEnv("UPDATE_CAMERA", "/camera/update/:id"),
		DeleteCamera:           getEnv("DELETE_CAMERA", "/camera/delete/:id"),
		ActivateCamera:         getEnv("ACTIVATE_CAMERA", "/camera/acivate/:id"),
		ActiveEmailAutoAlert:   getEnv("ACTIVE_EMAIL_AUTO_ALERT", "/camera/allEmailAutoAlert"),
		ActiveDisplayAutoAlert: getEnv("ACTIVE_DISPLAY_AUTO_ALERT", "/camera/allDisplayAutoAlert"),
		ActiveEmailAlert:       getEnv("ACTIVE_EMAIL_ALERT", "/camera/allEmailAlert"),
		ActiveDisplayAlert:     getEnv("ACTIVE_DISPLAY_ALERT", "/camera/allDisplayAlert"),
		EnableCamera:           getEnv("ENABLECAMERA", "/enableCamera"),
		SurveillanceStatus:     getEnv("SURVEILLANCESTATUS", "/SurveillanceStatus"),
		FeatureFlags:           getEnv("FEATURE_FLAGS", "/feature-flags"),

		PPEDetection:     os.Getenv("PPE_DETECTION") == "true",
		JewelryDetection: os.Getenv("JEWELRY_DETECTION") == "true",

		MyAlert:          getEnv("MY_ALERT", "/myAlert"),
		AutoAlert:        getEnv("AUTO_ALERT", "/autoAlert"),
		UserFeedback:     getEnv("USERFEEDBACK", "/userFeedBack"),
		RecentAlert:      getEnv("RECENT_ALERT", "/recentAlert/:hours"),
		ObjectOfInterest: getEnv("OBJECT_OF_INTEREST", "/objectOfInterest"),

		CreateAlert:         getEnv("CREATE_ALERT", "/alert/create"),
		UpdateAlert:         getEnv("UPDATE_ALERT", "/alert/update/:id"),
		AlertByCameraName:   getEnv("ALERT_BY_CAMERA_NAME", "/alert/:camera_name"),
		DeleteAlert:         getEnv("DELETE_ALERT", "/alert/delete/:id"),
		FindCameraByAlertID: getEnv("FIND_CAMERA_BY_ALERT_ID", "/alert/findCamerasByAlertId/:id"),

		CameraNames:            getEnv("CAMERA_NAMES", "/camera_names"),
		ObjectOfInterestLabels: getEnv("OBJECT_OF_INTEREST_LABELS", "/ObjectOfInterestLabels"),
		ReferenceImage:         getEnv("REFERENCE_IMAGE", "/areaOfInterest/:camera_name"),

		Insight:                 getEnv("INSIGHT", "/insight"),
		InsightReport:           getEnv("INSIGHT_REPORT", "/insightReport"),
		MailInsightReportStatus: getEnv("MAIL_INSIGHT_REPORT_STATUS", "/mail_insight_report_status"),
		MailInsightReport:       getEnv("MAIL_INSIGHT_REPORT", "/mail_insight_report"),

		Days: getEnv("DAYS", "/days"),

		EmailNotificationUpdate: getEnv("EMAILNOTIFICATIONUPDATE", "/email_notification/update"),
		EmailNotification:       getEnv("EMAILNOTIFICATION", "/email_notification"),

		KPIReport: getEnv("KPI_REPORT", "/kpi_report"),
	}

	return nil
}

// BaseURL returns the base URL for constructing public-facing URLs.
func (c Config) BaseURL() string {
	return fmt.Sprintf("%s://%s:%s", c.Protocol, c.Host, c.Port)
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
