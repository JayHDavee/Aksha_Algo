#!/usr/bin/env bash
# Build and push the ppe_detection_service (CPU) image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
docker login -u dockerhubalgo -p Aksha123#
docker build -t dockerhubalgo/ppe_container:latest .
docker push dockerhubalgo/ppe_container:latest