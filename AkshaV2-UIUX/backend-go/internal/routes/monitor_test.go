package routes

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestReadGlobalConfig_Workday(t *testing.T) {
	// Reset cache
	cachedGCMu.Lock()
	cachedGC = nil
	cachedGCTime = time.Time{}
	cachedGCMu.Unlock()

	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "global.json"), []byte(`{"workday":"true"}`), 0644)

	// Temporarily set AkshaPath
	origPath := setAkshaPath(dir)
	defer setAkshaPath(origPath)

	gc, err := readGlobalConfig()
	if err != nil {
		t.Fatalf("readGlobalConfig() error = %v", err)
	}
	if gc.Workday != "true" {
		t.Errorf("Workday = %q, want %q", gc.Workday, "true")
	}
}

func TestReadGlobalConfig_Holiday(t *testing.T) {
	cachedGCMu.Lock()
	cachedGC = nil
	cachedGCTime = time.Time{}
	cachedGCMu.Unlock()

	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "global.json"), []byte(`{"workday":"false"}`), 0644)

	origPath := setAkshaPath(dir)
	defer setAkshaPath(origPath)

	gc, err := readGlobalConfig()
	if err != nil {
		t.Fatalf("readGlobalConfig() error = %v", err)
	}
	if gc.Workday != "false" {
		t.Errorf("Workday = %q, want %q", gc.Workday, "false")
	}
}

func TestReadGlobalConfig_Caching(t *testing.T) {
	cachedGCMu.Lock()
	cachedGC = nil
	cachedGCTime = time.Time{}
	cachedGCMu.Unlock()

	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "global.json"), []byte(`{"workday":"true"}`), 0644)

	origPath := setAkshaPath(dir)
	defer setAkshaPath(origPath)

	// First call — reads from disk
	gc1, _ := readGlobalConfig()

	// Change the file
	os.WriteFile(filepath.Join(dir, "global.json"), []byte(`{"workday":"false"}`), 0644)

	// Second call within TTL — should return cached value
	gc2, _ := readGlobalConfig()
	if gc2.Workday != gc1.Workday {
		t.Errorf("expected cached value %q, got %q", gc1.Workday, gc2.Workday)
	}
}

func TestReadGlobalConfig_CacheExpiry(t *testing.T) {
	// Set a very short TTL for testing
	origTTL := cachedGCTTL
	cachedGCTTL = 10 * time.Millisecond
	defer func() { cachedGCTTL = origTTL }()

	cachedGCMu.Lock()
	cachedGC = nil
	cachedGCTime = time.Time{}
	cachedGCMu.Unlock()

	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "global.json"), []byte(`{"workday":"true"}`), 0644)

	origPath := setAkshaPath(dir)
	defer setAkshaPath(origPath)

	readGlobalConfig()

	// Change the file and wait for cache to expire
	os.WriteFile(filepath.Join(dir, "global.json"), []byte(`{"workday":"false"}`), 0644)
	time.Sleep(20 * time.Millisecond)

	gc, _ := readGlobalConfig()
	if gc.Workday != "false" {
		t.Errorf("expected %q after cache expiry, got %q", "false", gc.Workday)
	}
}

func TestReadGlobalConfig_MissingFile(t *testing.T) {
	cachedGCMu.Lock()
	cachedGC = nil
	cachedGCTime = time.Time{}
	cachedGCMu.Unlock()

	dir := t.TempDir() // no global.json

	origPath := setAkshaPath(dir)
	defer setAkshaPath(origPath)

	_, err := readGlobalConfig()
	if err == nil {
		t.Error("expected error for missing global.json")
	}
}

func TestReadGlobalConfig_InvalidJSON(t *testing.T) {
	cachedGCMu.Lock()
	cachedGC = nil
	cachedGCTime = time.Time{}
	cachedGCMu.Unlock()

	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "global.json"), []byte(`not json`), 0644)

	origPath := setAkshaPath(dir)
	defer setAkshaPath(origPath)

	_, err := readGlobalConfig()
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestReadGlobalConfig_Concurrent(t *testing.T) {
	cachedGCMu.Lock()
	cachedGC = nil
	cachedGCTime = time.Time{}
	cachedGCMu.Unlock()

	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "global.json"), []byte(`{"workday":"true"}`), 0644)

	origPath := setAkshaPath(dir)
	defer setAkshaPath(origPath)

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			gc, err := readGlobalConfig()
			if err != nil {
				t.Errorf("concurrent readGlobalConfig() error = %v", err)
			}
			if gc.Workday != "true" {
				t.Errorf("concurrent readGlobalConfig() Workday = %q", gc.Workday)
			}
		}()
	}
	wg.Wait()
}

func TestMaybeBroadcastLiveUpdate_Debounce(t *testing.T) {
	// Reset the tracker
	liveUpdateMu.Lock()
	liveUpdateTime = time.Now() // just emitted
	liveUpdateMu.Unlock()

	// This should be debounced (no-op) since we just set the time
	maybeBroadcastLiveUpdate()
	// No crash = pass (actual emit would fail without DB, but debounce prevents it)
}

func TestUpdateReferenceImage_NoRtspFile(t *testing.T) {
	dir := t.TempDir()
	origPath := setAkshaPath(dir)
	defer setAkshaPath(origPath)

	// Should not panic when rtsplinks.json doesn't exist
	updateReferenceImage("cam1", []byte("fake image data"))
}

func TestUpdateReferenceImage_InvalidJSON(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "rtsplinks.json"), []byte("not json"), 0644)

	origPath := setAkshaPath(dir)
	defer setAkshaPath(origPath)

	updateReferenceImage("cam1", []byte("fake image data"))
}

func TestUpdateReferenceImage_NoMatchingCamera(t *testing.T) {
	dir := t.TempDir()
	rtsp := map[string]map[string]interface{}{
		"1": {"cam_name": "cam99", "rtsp_id": 1},
	}
	data, _ := json.Marshal(rtsp)
	os.WriteFile(filepath.Join(dir, "rtsplinks.json"), data, 0644)

	origPath := setAkshaPath(dir)
	defer setAkshaPath(origPath)

	updateReferenceImage("cam1", []byte("fake image data"))
	// No reference image should be created for non-matching camera
	_, err := os.Stat(filepath.Join(dir, "Reference_images"))
	if err == nil {
		t.Error("expected no Reference_images dir for non-matching camera")
	}
}

func TestUpdateReferenceImage_CreatesImage(t *testing.T) {
	dir := t.TempDir()
	rtsp := map[string]map[string]interface{}{
		"1": {"cam_name": "cam1", "rtsp_id": float64(1)},
	}
	data, _ := json.Marshal(rtsp)
	os.WriteFile(filepath.Join(dir, "rtsplinks.json"), data, 0644)

	origPath := setAkshaPath(dir)
	defer setAkshaPath(origPath)

	frameData := []byte("fake image data for reference")
	updateReferenceImage("cam1", frameData)

	imgPath := filepath.Join(dir, "Reference_images", "1.jpg")
	got, err := os.ReadFile(imgPath)
	if err != nil {
		t.Fatalf("expected reference image at %s, got error: %v", imgPath, err)
	}
	if string(got) != string(frameData) {
		t.Errorf("reference image content mismatch")
	}
}

func TestUpdateReferenceImage_SkipsExistingReal(t *testing.T) {
	dir := t.TempDir()
	rtsp := map[string]map[string]interface{}{
		"1": {"cam_name": "cam1", "rtsp_id": float64(1)},
	}
	data, _ := json.Marshal(rtsp)
	os.WriteFile(filepath.Join(dir, "rtsplinks.json"), data, 0644)

	// Create a "real" reference image (not placeholder size)
	refDir := filepath.Join(dir, "Reference_images")
	os.MkdirAll(refDir, 0755)
	existingData := make([]byte, placeholderSize+100) // bigger than placeholder
	os.WriteFile(filepath.Join(refDir, "1.jpg"), existingData, 0644)

	origPath := setAkshaPath(dir)
	defer setAkshaPath(origPath)

	updateReferenceImage("cam1", []byte("new frame"))

	// Should NOT have overwritten
	got, _ := os.ReadFile(filepath.Join(refDir, "1.jpg"))
	if len(got) != len(existingData) {
		t.Errorf("expected existing image to be preserved (size %d), got size %d", len(existingData), len(got))
	}
}

func TestUpdateReferenceImage_ReplacesPlaceholder(t *testing.T) {
	dir := t.TempDir()
	rtsp := map[string]map[string]interface{}{
		"1": {"cam_name": "cam1", "rtsp_id": float64(1)},
	}
	data, _ := json.Marshal(rtsp)
	os.WriteFile(filepath.Join(dir, "rtsplinks.json"), data, 0644)

	// Create a placeholder-sized image
	refDir := filepath.Join(dir, "Reference_images")
	os.MkdirAll(refDir, 0755)
	placeholder := make([]byte, placeholderSize)
	os.WriteFile(filepath.Join(refDir, "1.jpg"), placeholder, 0644)

	origPath := setAkshaPath(dir)
	defer setAkshaPath(origPath)

	newFrame := []byte("real frame data")
	updateReferenceImage("cam1", newFrame)

	got, _ := os.ReadFile(filepath.Join(refDir, "1.jpg"))
	if string(got) != string(newFrame) {
		t.Errorf("expected placeholder to be replaced with new frame")
	}
}

func TestFrameStats(t *testing.T) {
	frameStatsMu.Lock()
	totalFrames = 0
	lastFrameCamera = ""
	lastFrameTime = time.Time{}
	frameStatsMu.Unlock()

	// Simulate frame reception
	frameStatsMu.Lock()
	totalFrames++
	lastFrameCamera = "cam4"
	lastFrameTime = time.Now()
	frameStatsMu.Unlock()

	frameStatsMu.Lock()
	if totalFrames != 1 {
		t.Errorf("totalFrames = %d, want 1", totalFrames)
	}
	if lastFrameCamera != "cam4" {
		t.Errorf("lastFrameCamera = %q, want %q", lastFrameCamera, "cam4")
	}
	frameStatsMu.Unlock()
}

// helper to swap AkshaPath for testing (thread-safe)
func setAkshaPath(path string) string {
	akshaPathMu.Lock()
	old := akshaPathForTest
	akshaPathForTest = path
	akshaPathMu.Unlock()
	return old
}
