// timeout.go — API timeout middleware
// Migrated from: src/appRoutes.js (apiTimeOut function)
package middleware

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// Timeout returns Gin middleware that sets a 30-second write deadline on the response.
func Timeout() gin.HandlerFunc {
	return func(c *gin.Context) {
		if w, ok := c.Writer.(http.Flusher); ok {
			_ = w
		}
		// Use a context deadline for the request
		c.Request = c.Request.WithContext(c.Request.Context())
		_ = http.NewResponseController(c.Writer).SetWriteDeadline(time.Now().Add(30 * time.Second))
		c.Next()
	}
}
