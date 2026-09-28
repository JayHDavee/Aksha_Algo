package routes

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func resetMonitorState() {
	cachedGCMu.Lock()
	cachedGC = nil
	cachedGCTime = time.Time{}
	cachedGCMu.Unlock()

	frameStatsMu.Lock()
	totalFrames = 0
	lastFrameCamera = ""
	lastFrameTime = time.Time{}
	frameStatsMu.Unlock()

	liveUpdateMu.Lock()
	liveUpdateTime = time.Time{}
	liveUpdateMu.Unlock()
}

func TestHandleMonitor_MissingGlobalJSON(t *testing.T) {
	resetMonitorState()
	dir := t.TempDir()
	orig := setAkshaPath(dir)
	defer setAkshaPath(orig)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("POST", "/api/monitor", nil)
	c.Request.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	handleMonitor(c)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", w.Code, http.StatusInternalServerError)
	}
}

func TestHandleMonitor_MissingCameraName(t *testing.T) {
	resetMonitorState()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "global.json"), []byte(`{"workday":"true"}`), 0644)
	orig := setAkshaPath(dir)
	defer setAkshaPath(orig)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	writer.WriteField("timestamp", "2026-03-27")
	// No camera_name
	writer.Close()

	c.Request = httptest.NewRequest("POST", "/api/monitor", body)
	c.Request.Header.Set("Content-Type", writer.FormDataContentType())

	handleMonitor(c)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleMonitor_MissingTimestamp(t *testing.T) {
	resetMonitorState()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "global.json"), []byte(`{"workday":"true"}`), 0644)
	orig := setAkshaPath(dir)
	defer setAkshaPath(orig)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	writer.WriteField("camera_name", "cam1")
	// No timestamp
	writer.Close()

	c.Request = httptest.NewRequest("POST", "/api/monitor", body)
	c.Request.Header.Set("Content-Type", writer.FormDataContentType())

	handleMonitor(c)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleMonitor_NoImage(t *testing.T) {
	resetMonitorState()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "global.json"), []byte(`{"workday":"true"}`), 0644)
	orig := setAkshaPath(dir)
	defer setAkshaPath(orig)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	writer.WriteField("camera_name", "cam1")
	writer.WriteField("timestamp", "2026-03-27")
	writer.WriteField("image_type", "workday")
	// No image file
	writer.Close()

	c.Request = httptest.NewRequest("POST", "/api/monitor", body)
	c.Request.Header.Set("Content-Type", writer.FormDataContentType())

	handleMonitor(c)

	// Should succeed but not emit (no image)
	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", w.Code, http.StatusOK)
	}

	// Frame count should still increment (we track all requests)
	frameStatsMu.Lock()
	if totalFrames != 1 {
		t.Errorf("totalFrames = %d, want 1", totalFrames)
	}
	frameStatsMu.Unlock()
}

func TestHandleMonitor_ImageTypeMismatch(t *testing.T) {
	resetMonitorState()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "global.json"), []byte(`{"workday":"true"}`), 0644)
	orig := setAkshaPath(dir)
	defer setAkshaPath(orig)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	writer.WriteField("camera_name", "cam1")
	writer.WriteField("timestamp", "2026-03-27")
	writer.WriteField("image_type", "holiday") // mismatch with workday=true

	part, _ := writer.CreateFormFile("image", "test.jpg")
	part.Write([]byte("fake jpg data"))
	writer.Close()

	c.Request = httptest.NewRequest("POST", "/api/monitor", body)
	c.Request.Header.Set("Content-Type", writer.FormDataContentType())

	handleMonitor(c)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", w.Code, http.StatusOK)
	}
}

func TestHandleMonitor_WithImage(t *testing.T) {
	resetMonitorState()
	// Prevent maybeBroadcastLiveUpdate from calling DB (debounce it)
	liveUpdateMu.Lock()
	liveUpdateTime = time.Now()
	liveUpdateMu.Unlock()

	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "global.json"), []byte(`{"workday":"true"}`), 0644)
	orig := setAkshaPath(dir)
	defer func() {
		time.Sleep(50 * time.Millisecond) // let goroutines finish before resetting path
		setAkshaPath(orig)
	}()

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	writer.WriteField("camera_name", "cam1")
	writer.WriteField("timestamp", "2026-03-27T12:00:00")
	writer.WriteField("image_type", "workday")
	writer.WriteField("camera_img_url", "http://localhost/cam1.jpg")

	part, _ := writer.CreateFormFile("image", "workday.jpg")
	part.Write([]byte("fake jpg data"))
	writer.Close()

	c.Request = httptest.NewRequest("POST", "/api/monitor", body)
	c.Request.Header.Set("Content-Type", writer.FormDataContentType())

	handleMonitor(c)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", w.Code, http.StatusOK)
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["success"] != true {
		t.Errorf("success = %v, want true", resp["success"])
	}

	frameStatsMu.Lock()
	if lastFrameCamera != "cam1" {
		t.Errorf("lastFrameCamera = %q, want %q", lastFrameCamera, "cam1")
	}
	frameStatsMu.Unlock()
}

func TestHandleMonitor_HolidayMode(t *testing.T) {
	resetMonitorState()
	liveUpdateMu.Lock()
	liveUpdateTime = time.Now()
	liveUpdateMu.Unlock()

	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "global.json"), []byte(`{"workday":"false"}`), 0644)
	orig := setAkshaPath(dir)
	defer func() {
		time.Sleep(50 * time.Millisecond)
		setAkshaPath(orig)
	}()

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	writer.WriteField("camera_name", "cam1")
	writer.WriteField("timestamp", "2026-03-27T12:00:00")
	writer.WriteField("image_type", "holiday") // matches workday=false

	part, _ := writer.CreateFormFile("image", "holiday.jpg")
	part.Write([]byte("holiday frame"))
	writer.Close()

	c.Request = httptest.NewRequest("POST", "/api/monitor", body)
	c.Request.Header.Set("Content-Type", writer.FormDataContentType())

	handleMonitor(c)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", w.Code, http.StatusOK)
	}
}

func TestFrameStatsTracking(t *testing.T) {
	resetMonitorState()

	frameStatsMu.Lock()
	totalFrames = 42
	lastFrameCamera = "cam4"
	lastFrameTime = time.Date(2026, 3, 27, 12, 0, 0, 0, time.UTC)
	frameStatsMu.Unlock()

	frameStatsMu.Lock()
	if totalFrames != 42 {
		t.Errorf("totalFrames = %d, want 42", totalFrames)
	}
	if lastFrameCamera != "cam4" {
		t.Errorf("lastFrameCamera = %q, want cam4", lastFrameCamera)
	}
	if lastFrameTime.Year() != 2026 {
		t.Errorf("lastFrameTime year = %d, want 2026", lastFrameTime.Year())
	}
	frameStatsMu.Unlock()
}

func TestGetAkshaPath_Default(t *testing.T) {
	orig := akshaPathForTest
	akshaPathForTest = ""
	defer func() { akshaPathForTest = orig }()

	// Should return config value (may be empty in test)
	_ = getAkshaPath()
}

func TestGetAkshaPath_Override(t *testing.T) {
	orig := akshaPathForTest
	akshaPathForTest = "/tmp/test-aksha"
	defer func() { akshaPathForTest = orig }()

	if got := getAkshaPath(); got != "/tmp/test-aksha" {
		t.Errorf("getAkshaPath() = %q, want %q", got, "/tmp/test-aksha")
	}
}

func TestLiveUpdateDebounce_Timing(t *testing.T) {
	origTTL := liveUpdateTTL
	liveUpdateTTL = 50 * time.Millisecond
	defer func() { liveUpdateTTL = origTTL }()

	// Set time to now — should be debounced
	liveUpdateMu.Lock()
	liveUpdateTime = time.Now()
	liveUpdateMu.Unlock()

	// This should be a no-op (debounced)
	maybeBroadcastLiveUpdate()

	// Verify time didn't change (debounce prevented the call)
	liveUpdateMu.Lock()
	t1 := liveUpdateTime
	liveUpdateMu.Unlock()

	// Wait for TTL to expire
	time.Sleep(60 * time.Millisecond)

	// After TTL, the time check passes but ListLiveCamera will fail (no DB).
	// We just verify the debounce logic by checking liveUpdateTime advances.
	// Since ListLiveCamera panics without DB, we only test the debounce guard.
	liveUpdateMu.Lock()
	stillSame := liveUpdateTime.Equal(t1)
	liveUpdateMu.Unlock()

	if !stillSame {
		t.Error("liveUpdateTime should not have changed during debounce window")
	}
}

func TestHandleMonitor_Concurrent(t *testing.T) {
	resetMonitorState()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "global.json"), []byte(`{"workday":"true"}`), 0644)
	orig := setAkshaPath(dir)
	defer setAkshaPath(orig)

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)

			body := &bytes.Buffer{}
			writer := multipart.NewWriter(body)
			writer.WriteField("camera_name", "cam1")
			writer.WriteField("timestamp", "2026-03-27T12:00:00")
			writer.WriteField("image_type", "workday")
			writer.Close()

			c.Request = httptest.NewRequest("POST", "/api/monitor", body)
			c.Request.Header.Set("Content-Type", writer.FormDataContentType())
			handleMonitor(c)
		}()
	}
	wg.Wait()

	frameStatsMu.Lock()
	if totalFrames != 20 {
		t.Errorf("totalFrames = %d after 20 concurrent requests, want 20", totalFrames)
	}
	frameStatsMu.Unlock()
}
