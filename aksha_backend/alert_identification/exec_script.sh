#!/usr/bin/env bash
# Build and push the alert_identification service image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
docker login -u dockerhubalgo -p Aksha123#
docker build -t dockerhubalgo/alert_identification:14072026-1 .
docker push dockerhubalgo/alert_identification:14072026-1

