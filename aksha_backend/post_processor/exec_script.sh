#!/usr/bin/env bash
# Build and push the post_processor service image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
docker login -u dockerhubalgo -p Aksha123#
docker build -t dockerhubalgo/post_processor:17082026-1 .
docker push dockerhubalgo/post_processor:17082026-1
