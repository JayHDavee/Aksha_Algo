#!/usr/bin/env bash
# Build and push the retention_service image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
docker login -u dockerhubalgo -p Aksha123#
docker build -t dockerhubalgo/retention_service:15062026-1 .
docker push dockerhubalgo/retention_service:15062026-1
