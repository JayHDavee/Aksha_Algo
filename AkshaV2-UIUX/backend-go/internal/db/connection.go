// Package db manages the MongoDB connection.
// Migrated from: src/db/connection.js
package db

import (
	"context"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// DB is the shared MongoDB database handle.
var DB *mongo.Database

// Client is the shared MongoDB client.
var Client *mongo.Client

// Connect establishes a connection to MongoDB using the provided URI.
func Connect(uri string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	clientOpts := options.Client().ApplyURI(uri)
	client, err := mongo.Connect(ctx, clientOpts)
	if err != nil {
		return err
	}

	if err := client.Ping(ctx, nil); err != nil {
		return err
	}

	Client = client
	DB = client.Database(getDatabaseName(uri))
	log.Println("MongoDB connection successful")
	return nil
}

// GetCollection returns a handle to the named collection.
func GetCollection(name string) *mongo.Collection {
	return DB.Collection(name)
}

// getDatabaseName extracts the database name from the MongoDB URI path.
// e.g. "mongodb://user:pass@host:27017/Aksha?authSource=admin" → "Aksha"
func getDatabaseName(uri string) string {
	// Find the path portion after host:port/
	// Skip the scheme "mongodb://" or "mongodb+srv://"
	rest := uri
	if idx := findSubstring(rest, "://"); idx >= 0 {
		rest = rest[idx+3:]
	}
	// Skip userinfo@ if present
	if idx := findByte(rest, '@'); idx >= 0 {
		rest = rest[idx+1:]
	}
	// Find the first "/" after host:port
	if idx := findByte(rest, '/'); idx >= 0 {
		rest = rest[idx+1:]
		// Remove query params
		if qIdx := findByte(rest, '?'); qIdx >= 0 {
			rest = rest[:qIdx]
		}
		if rest != "" {
			return rest
		}
	}
	return "aksha"
}

func findSubstring(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func findByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}
