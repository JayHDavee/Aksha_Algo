#!/usr/bin/env bash
# Build and push the object_detection_service_gpu (GPU/TRT) image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
docker login -u dockerhubalgo -p Aksha123#
docker build -t dockerhubalgo/object_detection_gpu:01062026 .
docker push dockerhubalgo/object_detection_gpu:01062026
