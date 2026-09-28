package utils

import "time"

// NormalizeDate parses a date string in various formats and returns it in YYYY-MM-DD format.
// Supported formats: YYYY-MM-DD, DD/MM/YY, DD/MM/YYYY, MM/DD/YYYY
func NormalizeDate(dateStr string) string {
	layouts := []string{
		"2006-01-02", // YYYY-MM-DD
		"02/01/06",   // DD/MM/YY
		"02/01/2006", // DD/MM/YYYY
	}
	for _, layout := range layouts {
		t, err := time.Parse(layout, dateStr)
		if err == nil {
			return t.Format("2006-01-02")
		}
	}
	return dateStr // return as-is if no format matches
}

// GetAllDatesBetween returns a slice of date strings (YYYY-MM-DD) from startDate to endDate inclusive.
func GetAllDatesBetween(startDate, endDate string) []string {
	startDate = NormalizeDate(startDate)
	endDate = NormalizeDate(endDate)

	layout := "2006-01-02"
	start, err := time.Parse(layout, startDate)
	if err != nil {
		return nil
	}
	end, err := time.Parse(layout, endDate)
	if err != nil {
		return nil
	}

	var dates []string
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		dates = append(dates, d.Format(layout))
	}
	return dates
}
