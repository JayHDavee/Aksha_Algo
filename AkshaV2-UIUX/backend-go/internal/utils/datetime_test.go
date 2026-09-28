package utils

import (
	"testing"
)

func TestNormalizeDate(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"YYYY-MM-DD passthrough", "2026-03-27", "2026-03-27"},
		{"DD/MM/YY", "27/03/26", "2026-03-27"},
		{"DD/MM/YYYY", "27/03/2026", "2026-03-27"},
		{"invalid format", "March 27, 2026", "March 27, 2026"},
		{"empty string", "", ""},
		{"partial date", "2026-03", "2026-03"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := NormalizeDate(tt.input)
			if got != tt.expected {
				t.Errorf("NormalizeDate(%q) = %q, want %q", tt.input, got, tt.expected)
			}
		})
	}
}

func TestGetAllDatesBetween(t *testing.T) {
	tests := []struct {
		name      string
		start     string
		end       string
		wantCount int
		wantFirst string
		wantLast  string
	}{
		{"single day", "2026-03-27", "2026-03-27", 1, "2026-03-27", "2026-03-27"},
		{"three days", "2026-03-25", "2026-03-27", 3, "2026-03-25", "2026-03-27"},
		{"cross month", "2026-01-30", "2026-02-02", 4, "2026-01-30", "2026-02-02"},
		{"DD/MM/YYYY format", "25/03/2026", "27/03/2026", 3, "2026-03-25", "2026-03-27"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := GetAllDatesBetween(tt.start, tt.end)
			if len(got) != tt.wantCount {
				t.Fatalf("GetAllDatesBetween(%q, %q) returned %d dates, want %d", tt.start, tt.end, len(got), tt.wantCount)
			}
			if got[0] != tt.wantFirst {
				t.Errorf("first date = %q, want %q", got[0], tt.wantFirst)
			}
			if got[len(got)-1] != tt.wantLast {
				t.Errorf("last date = %q, want %q", got[len(got)-1], tt.wantLast)
			}
		})
	}
}

func TestGetAllDatesBetween_InvalidStart(t *testing.T) {
	got := GetAllDatesBetween("not-a-date", "2026-03-27")
	if got != nil {
		t.Errorf("expected nil for invalid start date, got %v", got)
	}
}

func TestGetAllDatesBetween_InvalidEnd(t *testing.T) {
	got := GetAllDatesBetween("2026-03-27", "not-a-date")
	if got != nil {
		t.Errorf("expected nil for invalid end date, got %v", got)
	}
}

func TestGetAllDatesBetween_EndBeforeStart(t *testing.T) {
	got := GetAllDatesBetween("2026-03-27", "2026-03-25")
	if got != nil {
		t.Errorf("expected nil when end < start, got %v", got)
	}
}
