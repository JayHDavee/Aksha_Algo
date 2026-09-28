package azure

import (
	"os"
	"path/filepath"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
)

// CheckFileExists checks if an insight report file exists for the given date.
func CheckFileExists(date string) bool {
	path := filepath.Join(config.Cfg.AkshaPath, "insight_report", date+".json")
	_, err := os.Stat(path)
	return err == nil
}

// GetFileFromBlob reads the insight report JSON file for the given date.
func GetFileFromBlob(date string) ([]byte, error) {
	path := filepath.Join(config.Cfg.AkshaPath, "insight_report", date+".json")
	return os.ReadFile(path)
}
