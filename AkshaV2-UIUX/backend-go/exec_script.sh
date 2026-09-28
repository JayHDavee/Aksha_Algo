#!/usr/bin/env bash
# Build and push the Go backend image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
docker login -u dockerhubalgo -p Aksha123#
docker build -t dockerhubalgo/go_backend:15062026-1 .
docker push dockerhubalgo/go_backend:15062026-1
