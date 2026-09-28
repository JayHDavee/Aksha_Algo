#!/usr/bin/env bash
# Build and push the ppe_dashboard_service image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>
docker login -u dockerhubalgo -p Aksha123#
docker build -t dockerhubalgo/ppe_dashboard_service:17082026-1 .
docker push dockerhubalgo/ppe_dashboard_service:17082026-1
