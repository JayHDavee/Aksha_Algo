#!/usr/bin/env bash
# Build and push the deepstream_service image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
docker login -u dockerhubalgo -p Aksha123#
docker build -t dockerhubalgo/deepstream_service:18062026-1 .
docker push dockerhubalgo/deepstream_service:18062026-1
