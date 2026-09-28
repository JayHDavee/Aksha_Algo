package utils

// IsPointInsidePolygon uses ray-casting to test if a point is inside a polygon.
func IsPointInsidePolygon(point [2]float64, vs [][2]float64) bool {
	x, y := point[0], point[1]
	inside := false
	j := len(vs) - 1
	for i := 0; i < len(vs); i++ {
		xi, yi := vs[i][0], vs[i][1]
		xj, yj := vs[j][0], vs[j][1]
		if (yi > y) != (yj > y) && x < (xj-xi)*(y-yi)/(yj-yi)+xi {
			inside = !inside
		}
		j = i
	}
	return inside
}
