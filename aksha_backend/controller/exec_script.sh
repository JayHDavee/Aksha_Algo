#!/usr/bin/env bash
# Build and push the controller service image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
docker login -u dockerhubalgo -p Aksha123#
docker build -t dockerhubalgo/controller:02072026-1 .
docker push dockerhubalgo/controller:02072026-1