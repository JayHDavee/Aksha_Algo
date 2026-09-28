package routes

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

func init() {
	gin.SetMode(gin.TestMode)
}

func TestStaticOrNotFound_EmptyRoot(t *testing.T) {
	handler := staticOrNotFound("")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("GET", "/anything", nil)

	handler(c)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", w.Code, http.StatusNotFound)
	}
}

func TestStaticOrNotFound_FileExists(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "test.jpg"), []byte("image data"), 0644)

	handler := staticOrNotFound(dir)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("GET", "/test.jpg", nil)

	handler(c)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", w.Code, http.StatusOK)
	}
	if w.Body.String() != "image data" {
		t.Errorf("body = %q, want %q", w.Body.String(), "image data")
	}
}

func TestStaticOrNotFound_FileNotExists(t *testing.T) {
	dir := t.TempDir()

	handler := staticOrNotFound(dir)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("GET", "/nonexistent.jpg", nil)

	handler(c)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", w.Code, http.StatusNotFound)
	}
}

func TestStaticOrNotFound_PostMethod(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "test.jpg"), []byte("image data"), 0644)

	handler := staticOrNotFound(dir)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("POST", "/test.jpg", nil)

	handler(c)

	// POST should not serve static files
	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d for POST, want %d", w.Code, http.StatusNotFound)
	}
}

func TestStaticOrNotFound_HeadMethod(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "test.jpg"), []byte("image data"), 0644)

	handler := staticOrNotFound(dir)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("HEAD", "/test.jpg", nil)

	handler(c)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d for HEAD, want %d", w.Code, http.StatusOK)
	}
}

func TestStaticOrNotFound_NestedPath(t *testing.T) {
	dir := t.TempDir()
	subDir := filepath.Join(dir, "cam4", "alerts", "2026-03-27")
	os.MkdirAll(subDir, 0755)
	os.WriteFile(filepath.Join(subDir, "alert.jpg"), []byte("alert img"), 0644)

	handler := staticOrNotFound(dir)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("GET", "/cam4/alerts/2026-03-27/alert.jpg", nil)

	handler(c)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", w.Code, http.StatusOK)
	}
	if w.Body.String() != "alert img" {
		t.Errorf("body = %q, want %q", w.Body.String(), "alert img")
	}
}

func TestStaticOrNotFound_URLEncodedSpaces(t *testing.T) {
	dir := t.TempDir()
	subDir := filepath.Join(dir, "cam4", "alerts")
	os.MkdirAll(subDir, 0755)
	os.WriteFile(filepath.Join(subDir, "2026-03-27 14_46_17_alert.jpg"), []byte("alert"), 0644)

	handler := staticOrNotFound(dir)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	// URL-encoded space
	c.Request = httptest.NewRequest("GET", "/cam4/alerts/2026-03-27%2014_46_17_alert.jpg", nil)

	handler(c)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", w.Code, http.StatusOK)
	}
}

func TestLogServerStats(t *testing.T) {
	// Should not panic
	logServerStats("Test")
}
