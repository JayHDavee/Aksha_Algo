#!/usr/bin/env bash
# Build and push the frontend image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
docker login -u dockerhubalgo -p Aksha123#
docker build -t dockerhubalgo/aksha_refactor_frontend:12082026-3 .
docker push dockerhubalgo/aksha_refactor_frontend:12082026-3
