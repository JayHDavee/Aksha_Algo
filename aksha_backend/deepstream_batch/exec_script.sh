#!/usr/bin/env bash
# Build and push the deepstream_batch service image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
docker login -u dockerhubalgo -p Aksha123#
docker build -t dockerhubalgo/deepstream_batch:latest .
docker push dockerhubalgo/deepstream_batch:latest
