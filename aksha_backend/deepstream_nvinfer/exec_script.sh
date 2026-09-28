#!/usr/bin/env bash
# Build and push the deepstream_nvinfer service image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
docker login -u dockerhubalgo -p Aksha123#
docker build -t dockerhubalgo/deepstream_nvinfer:20072026-1 .
docker push dockerhubalgo/deepstream_nvinfer:20072026-1
