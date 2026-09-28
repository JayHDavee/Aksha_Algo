# Aksha V2.1 — Deployment

## Quick Start

### 1. Make the script executable
```bash
chmod +x start.sh
```

### 2. Pull images and start all containers
```bash
./start.sh
```

### 3. View logs
```bash
docker compose logs -f api_service
docker compose logs -f deepstream-nvinfer1
```

### 4. Stop all containers
```bash
docker compose down
```

---

## Directory Structure

```
deployment/
├── start.sh                              # Main start script (sets paths, pulls images, starts compose)
├── docker-compose.yml                    # Default stack (CPU, standard cameras)
├── docker-compose-gpu.yml                # GPU-enabled stack
├── docker-compose-nvinfer-70cams.yml     # DeepStream NvInfer — 105 cameras, 10 pods
├── docker-compose-deepstream-single.yml  # Single DeepStream pod (dev/test)
├── docker-compose-deepstream-batch-50-cams.yml  # Batch deepstream variant
└── Aksha/                                # Runtime data volume (mounted into containers)
    ├── rtsplinks.json                    # Camera registry — all 105 cameras with batch_id
    ├── rtsplinks-new.json                # Alternate/staging camera list
    ├── global.json                       # Global flags (e.g. workday toggle)
    ├── app.config                        # Client thread ID and shared config
    ├── trt_cache/                        # TensorRT engine cache (shared across pods)
    └── log/                              # Container logs
```

---

## DeepStream NvInfer Stack (105 cameras)

Use `docker-compose-nvinfer-70cams.yml` for the full production deployment.

```bash
# Start
docker compose -f docker-compose-nvinfer-70cams.yml up -d

# Stop
docker compose -f docker-compose-nvinfer-70cams.yml down

# Restart a single pod (e.g. after image update)
docker compose -f docker-compose-nvinfer-70cams.yml up -d deepstream-nvinfer1
```

### Pod layout

| Pod | Container | Cameras (batch_id) | Port |
|-----|-----------|--------------------|------|
| 1 | deepstream-nvinfer1 | cam1–cam11 | 8001 |
| 2 | deepstream-nvinfer2 | cam12–cam22 | 8002 |
| ... | ... | ... | ... |
| 10 | deepstream-nvinfer10 | cam95–cam105 | 8010 |

Cameras are assigned to pods via `batch_id` in `Aksha/rtsplinks.json`.

### Updating the DeepStream image

1. Build and push from the dev machine:
   ```bash
   cd ../aksha_backend/deepstream_nvinfer
   bash exec_script.sh          # builds & pushes dockerhubalgo/deepstream_nvinfer:<tag>
   ```
2. Pull and redeploy on the server:
   ```bash
   docker compose -f docker-compose-nvinfer-70cams.yml pull deepstream-nvinfer1
   docker compose -f docker-compose-nvinfer-70cams.yml up -d deepstream-nvinfer1
   ```
   Repeat for each pod, or redeploy all at once:
   ```bash
   docker compose -f docker-compose-nvinfer-70cams.yml pull
   docker compose -f docker-compose-nvinfer-70cams.yml up -d
   ```

### TensorRT engine cache

The first pod (`deepstream-nvinfer1`) builds the TRT engine on first start (~5–8 min for YOLOv10 FP16 on RTX 3050). Pods 2–10 wait for pod 1 to become healthy, then load the cached engine in ~2s. The engine is stored at:
```
./Aksha/trt_cache/yolov10_b40_fp16_sm86.engine
```

---

## Camera Management

### Add a camera at runtime (no pipeline restart)
```bash
curl -X POST http://localhost:8001/add \
  -H "Content-Type: application/json" \
  -d '{"cam_name":"cam1","rtsp_url":"rtsp://user:pass@ip:554/path","rtsp_id":"1","batch_id":1}'
```

### Remove a camera at runtime
```bash
curl -X DELETE http://localhost:8001/remove/cam1
```

### Check pipeline health
```bash
curl http://localhost:8001/health
```

### Reload cameras from rtsplinks.json
```bash
curl -X POST http://localhost:8001/reload
```

---

## Notes

- `start.sh` auto-generates the `.env` file with absolute paths — works on any machine without hardcoding
- VRAM budget (RTX 3050, 8GB): 10 pods × ~700MB = ~7GB. Monitor with `nvidia-smi`
- Kafka has 30 partitions for 105 cameras × 5fps throughput
- If a camera returns repeated 404s, the pipeline backs off exponentially (2min → 5min → 10min) before retrying
