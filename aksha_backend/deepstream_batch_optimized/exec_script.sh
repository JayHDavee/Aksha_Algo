#!/usr/bin/env bash
# Build and push the deepstream_batch_optimized service image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
docker login -u dockerhubalgo -p Aksha123#
docker build -t dockerhubalgo/deepstream_batch_optimized:30052026-9  .
docker push dockerhubalgo/deepstream_batch_optimized:30052026-9
