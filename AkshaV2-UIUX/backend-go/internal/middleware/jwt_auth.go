// Package middleware contains HTTP middleware for the Gin router.
// Migrated from: src/middleware/jwtAuthMiddleware.js
package middleware

import (
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"github.com/algoanalytics-pvt/aksha-backend/internal/config"
)

// JWTAuth is Gin middleware that validates JWT tokens from the Authorization
// header (Bearer token) or from a cookie named "token".
// Matches Node.js jose jwtVerify() behavior: HS256 + issuer "askha-express".
func JWTAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		var tokenStr string

		// Check Authorization header first (same as Node.js: req.headers["authorization"])
		auth := c.GetHeader("Authorization")
		if auth != "" {
			parts := strings.SplitN(auth, " ", 2)
			if len(parts) == 2 {
				tokenStr = parts[1]
			}
		}

		// Fall back to cookie (same as Node.js: req.cookies.token)
		if tokenStr == "" {
			cookie, err := c.Cookie("token")
			if err != nil || cookie == "" {
				log.Printf("[JWT] No token found for %s %s", c.Request.Method, c.Request.URL.Path)
				c.AbortWithStatusJSON(http.StatusUnauthorized, "Unauthorized")
				return
			}
			tokenStr = cookie
		}

		// Parse and validate the token
		secret := []byte(config.Cfg.JWTSecret)
		token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
			}
			return secret, nil
		}, jwt.WithValidMethods([]string{"HS256"}),
			jwt.WithIssuer("askha-express"))

		if err != nil || !token.Valid {
			msg := "unknown"
			if err != nil {
				msg = err.Error()
			}
			log.Printf("[JWT] Authentication failed for %s %s: %s", c.Request.Method, c.Request.URL.Path, msg)
			c.AbortWithStatusJSON(http.StatusUnauthorized,
				fmt.Sprintf("Authentication failed: %s", msg))
			return
		}

		// Store claims in context (same as Node.js: req.user = jwtToken.payload)
		if claims, ok := token.Claims.(jwt.MapClaims); ok {
			c.Set("user", claims)
		}

		c.Next()
	}
}
