#!/usr/bin/env bash
# Build and push the jewelry_container (CPU) image to Docker Hub.
# Tag format: DDMMYYYY-<build-number>  (update before each release)
# Requires `docker login` to already be authenticated (don't hardcode credentials here).
docker build -t dockerhubalgo/jewelry_container:latest .
docker push dockerhubalgo/jewelry_container:latest
