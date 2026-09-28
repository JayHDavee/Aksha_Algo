package utils

import (
	"context"
	"log"
	"strings"

	"go.mongodb.org/mongo-driver/bson"

	"github.com/algoanalytics-pvt/aksha-backend/internal/db"
)

// Observer discovers all meta_* collections on startup.
// In the Go version, no dynamic schema registration is needed since we use raw BSON.
func Observer() {
	ctx := context.Background()
	collections, err := db.DB.ListCollectionNames(ctx, bson.M{})
	if err != nil {
		log.Printf("Observer: failed to list collections: %v", err)
		return
	}

	for _, name := range collections {
		if strings.HasPrefix(strings.ToLower(name), "meta_") {
			log.Printf("Observer: found meta collection: %s", name)
		}
	}
}
