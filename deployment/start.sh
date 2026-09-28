#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AKSHA_PATH="${SCRIPT_DIR}/Aksha"

echo "✓ Current directory: ${SCRIPT_DIR}"
echo "✓ Aksha path: ${AKSHA_PATH}"

export HOST_MACHINE_AKSHA_PATH="${AKSHA_PATH}"


#  Enable GPU (change to false if needed)
export ENABLE_GPU=false


cd "${SCRIPT_DIR}"

docker login -u dockerhubalgo -p Aksha123#
docker pull dockerhubalgo/frame_reader:23042026
docker tag dockerhubalgo/frame_reader:23042026 dockerhubalgo/frame_reader:latest
docker pull dockerhubalgo/anamoly_model_loader:23042026

docker compose up -d

echo "✓ Docker compose started successfully"
echo "✓ Volumes will be saved to: ${AKSHA_PATH}"