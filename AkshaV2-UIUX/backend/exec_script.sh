#!/usr/bin/env bash
# Build and push the node backend image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
docker login -u dockerhubalgo -p Aksha123#
docker build --no-cache -t dockerhubalgo/aksha_refactor_backend:28072026-2 .
docker push dockerhubalgo/aksha_refactor_backend:28072026-2
