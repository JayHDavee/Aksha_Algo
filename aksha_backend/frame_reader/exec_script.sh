#!/usr/bin/env bash
# Build and push the frame_reader image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
docker login -u dockerhubalgo -p Aksha123#
docker build -t dockerhubalgo/frame_reader:15062026-1 .
docker push dockerhubalgo/frame_reader:15062026-1
