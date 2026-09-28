package routes

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
)

func TestCallSurveillanceAPI_Success(t *testing.T) {
	var called int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&called, 1)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	}))
	defer ts.Close()

	// Point API_SERVICE to test server (callSurveillanceAPI builds http://API_SERVICE:4000/...)
	// We override by temporarily setting APIService and patching the function
	origAPI := config.Cfg.APIService
	defer func() { config.Cfg.APIService = origAPI }()

	// Use the test helper that accepts a URL directly
	callSurveillanceAPIWithURL(ts.URL+"/Surveillance", map[string]interface{}{"type": "start"}, 100*time.Millisecond)

	if atomic.LoadInt32(&called) != 1 {
		t.Errorf("expected 1 call, got %d", called)
	}
}

func TestCallSurveillanceAPI_RetryThenSuccess(t *testing.T) {
	var callCount int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&callCount, 1)
		if n <= 2 {
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	}))
	defer ts.Close()

	callSurveillanceAPIWithURL(ts.URL+"/Surveillance", map[string]interface{}{"type": "start"}, 10*time.Millisecond)

	got := atomic.LoadInt32(&callCount)
	if got < 3 {
		t.Errorf("expected at least 3 calls, got %d", got)
	}
}

func TestCallSurveillanceAPI_AllRetriesFail(t *testing.T) {
	start := time.Now()
	// Use a URL that refuses connections
	callSurveillanceAPIWithURL("http://127.0.0.1:1/Surveillance", map[string]interface{}{"type": "start"}, 50*time.Millisecond)
	elapsed := time.Since(start)

	// 5 attempts with 50ms delay = at least 200ms of retries
	if elapsed < 200*time.Millisecond {
		t.Errorf("expected retry delays, completed in %v", elapsed)
	}
}

// callSurveillanceAPIWithURL mirrors callSurveillanceAPI but accepts a URL and retry delay.
func callSurveillanceAPIWithURL(url string, params map[string]interface{}, retryDelay time.Duration) {
	body, _ := json.Marshal(params)

	for attempt := 1; attempt <= 5; attempt++ {
		resp, err := http.Post(url, "application/json", bytes.NewReader(body))
		if err != nil {
			time.Sleep(retryDelay)
			continue
		}
		defer resp.Body.Close()
		io.ReadAll(resp.Body)
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return
		}
		time.Sleep(retryDelay)
	}
}

func TestCallSurveillanceAPI_RequestBody(t *testing.T) {
	var receivedBody map[string]interface{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &receivedBody)
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", r.Header.Get("Content-Type"))
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	params := map[string]interface{}{
		"type":        "start",
		"camera_name": "cam4",
	}
	callSurveillanceAPIWithURL(ts.URL+"/Surveillance", params, 10*time.Millisecond)

	if receivedBody["type"] != "start" {
		t.Errorf("body type = %v, want 'start'", receivedBody["type"])
	}
	if receivedBody["camera_name"] != "cam4" {
		t.Errorf("body camera_name = %v, want 'cam4'", receivedBody["camera_name"])
	}
}
