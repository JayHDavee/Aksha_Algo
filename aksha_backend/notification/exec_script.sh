#!/usr/bin/env bash
# Build and push the notification service image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
docker login -u dockerhubalgo -p Aksha123#
docker build -t dockerhubalgo/notification:17072026-1 .
docker push dockerhubalgo/notification:17072026-1
