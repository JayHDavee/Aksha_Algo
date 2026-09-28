package config

import (
	"os"
	"path/filepath"
	"testing"
)

func clearEnv(keys ...string) {
	for _, k := range keys {
		os.Unsetenv(k)
	}
}

func TestGetEnv_WithValue(t *testing.T) {
	os.Setenv("TEST_KEY_1", "hello")
	defer os.Unsetenv("TEST_KEY_1")

	got := getEnv("TEST_KEY_1", "default")
	if got != "hello" {
		t.Errorf("getEnv() = %q, want %q", got, "hello")
	}
}

func TestGetEnv_Fallback(t *testing.T) {
	os.Unsetenv("TEST_KEY_MISSING")
	got := getEnv("TEST_KEY_MISSING", "fallback")
	if got != "fallback" {
		t.Errorf("getEnv() = %q, want %q", got, "fallback")
	}
}

func TestGetEnv_EmptyValue(t *testing.T) {
	os.Setenv("TEST_KEY_EMPTY", "")
	defer os.Unsetenv("TEST_KEY_EMPTY")

	got := getEnv("TEST_KEY_EMPTY", "fallback")
	if got != "fallback" {
		t.Errorf("getEnv() = %q, want %q (empty string should use fallback)", got, "fallback")
	}
}

func TestBaseURL(t *testing.T) {
	tests := []struct {
		name     string
		config   Config
		expected string
	}{
		{"default", Config{Protocol: "http", Host: "localhost", Port: "5000"}, "http://localhost:5000"},
		{"https", Config{Protocol: "https", Host: "example.com", Port: "443"}, "https://example.com:443"},
		{"custom", Config{Protocol: "http", Host: "192.168.1.1", Port: "8080"}, "http://192.168.1.1:8080"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.config.BaseURL()
			if got != tt.expected {
				t.Errorf("BaseURL() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestInit_Defaults(t *testing.T) {
	// Clear all env vars that Init reads
	envKeys := []string{
		"GO_ENV", "NODE_ENV", "PORT", "DATABASE", "AKSHA_PATH",
		"JWT_SECRET", "API_SERVICE", "PROTOCOL", "HOST",
	}
	for _, k := range envKeys {
		os.Unsetenv(k)
	}

	err := Init()
	if err != nil {
		t.Fatalf("Init() error = %v", err)
	}

	if Cfg.Port != "5000" {
		t.Errorf("Port = %q, want %q", Cfg.Port, "5000")
	}
	if Cfg.Protocol != "http" {
		t.Errorf("Protocol = %q, want %q", Cfg.Protocol, "http")
	}
	if Cfg.Host != "localhost" {
		t.Errorf("Host = %q, want %q", Cfg.Host, "localhost")
	}
	if Cfg.JWTSecret != "akshajwt" {
		t.Errorf("JWTSecret = %q, want %q", Cfg.JWTSecret, "akshajwt")
	}
	if Cfg.MyAlert != "/myAlert" {
		t.Errorf("MyAlert = %q, want %q", Cfg.MyAlert, "/myAlert")
	}
	if Cfg.CameraCreate != "/camera/create" {
		t.Errorf("CameraCreate = %q, want %q", Cfg.CameraCreate, "/camera/create")
	}
	if Cfg.KPIReport != "/kpi_report" {
		t.Errorf("KPIReport = %q, want %q", Cfg.KPIReport, "/kpi_report")
	}
}

func TestInit_WithEnvOverrides(t *testing.T) {
	os.Setenv("PORT", "9999")
	os.Setenv("DATABASE", "mongodb://test:27017")
	os.Setenv("PROTOCOL", "https")
	os.Setenv("HOST", "myhost")
	defer clearEnv("PORT", "DATABASE", "PROTOCOL", "HOST")

	err := Init()
	if err != nil {
		t.Fatalf("Init() error = %v", err)
	}

	if Cfg.Port != "9999" {
		t.Errorf("Port = %q, want %q", Cfg.Port, "9999")
	}
	if Cfg.Database != "mongodb://test:27017" {
		t.Errorf("Database = %q, want %q", Cfg.Database, "mongodb://test:27017")
	}
	if Cfg.Protocol != "https" {
		t.Errorf("Protocol = %q, want %q", Cfg.Protocol, "https")
	}
	if Cfg.Host != "myhost" {
		t.Errorf("Host = %q, want %q", Cfg.Host, "myhost")
	}
}

func TestInit_WithEnvFile(t *testing.T) {
	// Create a temp .env file
	dir := t.TempDir()
	envFile := filepath.Join(dir, ".env")
	os.WriteFile(envFile, []byte("PORT=7777\nHOST=envfilehost\n"), 0644)

	// Clear vars so .env can set them
	clearEnv("PORT", "HOST", "GO_ENV", "NODE_ENV")

	// Change to temp dir so godotenv.Load(".env") finds our file
	origDir, _ := os.Getwd()
	os.Chdir(dir)
	defer os.Chdir(origDir)

	err := Init()
	if err != nil {
		t.Fatalf("Init() error = %v", err)
	}

	if Cfg.Port != "7777" {
		t.Errorf("Port = %q, want %q", Cfg.Port, "7777")
	}
	if Cfg.Host != "envfilehost" {
		t.Errorf("Host = %q, want %q", Cfg.Host, "envfilehost")
	}

	// Clean up env vars set by .env file
	clearEnv("PORT", "HOST")
}

func TestInit_WithGOENV(t *testing.T) {
	dir := t.TempDir()
	envFile := filepath.Join(dir, ".env.production")
	os.WriteFile(envFile, []byte("PORT=4444\n"), 0644)

	clearEnv("PORT", "GO_ENV", "NODE_ENV")
	os.Setenv("GO_ENV", "production")
	defer os.Unsetenv("GO_ENV")

	origDir, _ := os.Getwd()
	os.Chdir(dir)
	defer os.Chdir(origDir)

	err := Init()
	if err != nil {
		t.Fatalf("Init() error = %v", err)
	}

	if Cfg.Port != "4444" {
		t.Errorf("Port = %q, want %q", Cfg.Port, "4444")
	}
	clearEnv("PORT")
}

func TestInit_NODE_ENV_Fallback(t *testing.T) {
	dir := t.TempDir()
	envFile := filepath.Join(dir, ".env.staging")
	os.WriteFile(envFile, []byte("PORT=3333\n"), 0644)

	clearEnv("PORT", "GO_ENV", "NODE_ENV")
	os.Setenv("NODE_ENV", "staging")
	defer os.Unsetenv("NODE_ENV")

	origDir, _ := os.Getwd()
	os.Chdir(dir)
	defer os.Chdir(origDir)

	err := Init()
	if err != nil {
		t.Fatalf("Init() error = %v", err)
	}

	if Cfg.Port != "3333" {
		t.Errorf("Port = %q, want %q", Cfg.Port, "3333")
	}
	clearEnv("PORT")
}

func TestInit_AllRouteDefaults(t *testing.T) {
	clearEnv("GO_ENV", "NODE_ENV")
	Init()

	routes := map[string]string{
		"CameraCreate":           Cfg.CameraCreate,
		"CameraList":             Cfg.CameraList,
		"CameraLimit":            Cfg.CameraLimit,
		"UpdateCamera":           Cfg.UpdateCamera,
		"DeleteCamera":           Cfg.DeleteCamera,
		"ActivateCamera":         Cfg.ActivateCamera,
		"ActiveEmailAutoAlert":   Cfg.ActiveEmailAutoAlert,
		"ActiveDisplayAutoAlert": Cfg.ActiveDisplayAutoAlert,
		"ActiveEmailAlert":       Cfg.ActiveEmailAlert,
		"ActiveDisplayAlert":     Cfg.ActiveDisplayAlert,
		"EnableCamera":           Cfg.EnableCamera,
		"SurveillanceStatus":     Cfg.SurveillanceStatus,
		"AutoAlert":              Cfg.AutoAlert,
		"UserFeedback":           Cfg.UserFeedback,
		"RecentAlert":            Cfg.RecentAlert,
		"ObjectOfInterest":       Cfg.ObjectOfInterest,
		"CreateAlert":            Cfg.CreateAlert,
		"UpdateAlert":            Cfg.UpdateAlert,
		"AlertByCameraName":      Cfg.AlertByCameraName,
		"DeleteAlert":            Cfg.DeleteAlert,
		"FindCameraByAlertID":    Cfg.FindCameraByAlertID,
		"CameraNames":            Cfg.CameraNames,
		"ObjectOfInterestLabels": Cfg.ObjectOfInterestLabels,
		"ReferenceImage":         Cfg.ReferenceImage,
		"Insight":                Cfg.Insight,
		"InsightReport":          Cfg.InsightReport,
		"MailInsightReportStatus": Cfg.MailInsightReportStatus,
		"MailInsightReport":      Cfg.MailInsightReport,
		"Days":                   Cfg.Days,
		"EmailNotificationUpdate": Cfg.EmailNotificationUpdate,
		"EmailNotification":      Cfg.EmailNotification,
		"KPIReport":              Cfg.KPIReport,
	}

	for name, val := range routes {
		if val == "" {
			t.Errorf("%s is empty, expected a default route path", name)
		}
	}
}
