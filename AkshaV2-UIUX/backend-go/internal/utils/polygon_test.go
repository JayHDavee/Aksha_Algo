package utils

import "testing"

func TestIsPointInsidePolygon(t *testing.T) {
	// Square with corners at (0,0), (10,0), (10,10), (0,10)
	square := [][2]float64{{0, 0}, {10, 0}, {10, 10}, {0, 10}}

	tests := []struct {
		name   string
		point  [2]float64
		poly   [][2]float64
		inside bool
	}{
		{"center of square", [2]float64{5, 5}, square, true},
		{"inside near edge", [2]float64{1, 1}, square, true},
		{"outside right", [2]float64{15, 5}, square, false},
		{"outside above", [2]float64{5, 15}, square, false},
		{"outside negative", [2]float64{-1, -1}, square, false},
		{"outside left", [2]float64{-5, 5}, square, false},
		{"triangle inside", [2]float64{1, 1}, [][2]float64{{0, 0}, {10, 0}, {5, 10}}, true},
		{"triangle outside", [2]float64{0, 10}, [][2]float64{{0, 0}, {10, 0}, {5, 10}}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsPointInsidePolygon(tt.point, tt.poly)
			if got != tt.inside {
				t.Errorf("IsPointInsidePolygon(%v, ...) = %v, want %v", tt.point, got, tt.inside)
			}
		})
	}
}

func TestIsPointInsidePolygon_EmptyPolygon(t *testing.T) {
	got := IsPointInsidePolygon([2]float64{5, 5}, nil)
	if got {
		t.Error("expected false for empty polygon")
	}
}

func TestIsPointInsidePolygon_ComplexPolygon(t *testing.T) {
	// L-shaped polygon
	lShape := [][2]float64{
		{0, 0}, {5, 0}, {5, 5}, {10, 5}, {10, 10}, {0, 10},
	}
	tests := []struct {
		name   string
		point  [2]float64
		inside bool
	}{
		{"inside lower left", [2]float64{2, 2}, true},
		{"inside upper right", [2]float64{7, 7}, true},
		{"outside upper right corner", [2]float64{7, 2}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsPointInsidePolygon(tt.point, lShape)
			if got != tt.inside {
				t.Errorf("IsPointInsidePolygon(%v) = %v, want %v", tt.point, got, tt.inside)
			}
		})
	}
}
