#!/usr/bin/env bash
# Build and push the anomaly_model_loader image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
docker login -u dockerhubalgo -p Aksha123#
docker build -t dockerhubalgo/anamoly_model_loader:15062026-1 .
docker push dockerhubalgo/anamoly_model_loader:15062026-1
