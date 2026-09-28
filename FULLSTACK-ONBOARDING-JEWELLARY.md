# Jewellery — Full-Stack Onboarding

**For:** a developer picking up the jewellery-store surveillance use case in Aksha v2.1.
**Verified against:** commit `f9ca20a3` (merge of PR #31 `jewellary`). Every path, endpoint, Kafka topic and Mongo field below was read out of the source.
**Design context:** `JEWELRY-STORE-CV-DESIGN.md`.

Jewellery is the **most complete use case in the platform** and the reference other use cases are cloned from. It ships with the feature flag **off**.

> ⚠️ **Spelling.** The directory is `aksha_backend/jewellary_usecase/` while every symbol inside is `jewelry_*`, and the frontend/backend all use `jewelry`. Only the directory name is misspelled. Do not "fix" it without updating `exec_script.sh`, the dockerfile and both controllers.

---

## 1. Status at a glance

### Already implemented

| Layer | Artefact |
|---|---|
| Detection pipeline | `aksha_backend/jewellary_usecase/` → `dockerhubalgo/jewelry_container:latest` |
| Rule engine | 12 `Rule` classes, 14 severities, `AlertBus` with cooldown |
| Kafka output | topic `jewelry_results` |
| Alertification | `alert_identification/jewelry_alert_consumer.py` |
| Post-processor | `meta_jewelry_<cam>` + shared `alerts` dual-write + notification |
| Backend API | `backend/src/routes/jewelryDashboard.ts` — 3 endpoints |
| Camera wiring | `Detection_Type` enum, `resolveDeploymentMode`, `/feature-flags` |
| Frontend | `container/jewelryDashboard/`, `context/FeatureFlagsContext.tsx`, nav entry, route |
| Controller | Docker **and** Kubernetes, all four operations |
| Config | `JEWELRY_DETECTION` flag, `labels_jewelry.txt`, compose consumer service |

### Needs implementation

| Gap | Where | Impact |
|---|---|---|
| **Per-camera zones** | `app/jewelry_zones.py` — only `"default"` layout exists | Every jewellery camera shares one hardcoded store layout. No editor, no DB field, no API |
| **Per-camera thresholds** | `app/jewelry_rules.py` `CFG` | Business hours, occupancy limit, dwell times are global constants |
| **3 rules can never fire** | `CASH_DRAWER_OPEN`, `SAFE_DOOR_OPEN` (`class_map` → `None`); `FOOTFALL` (counts accumulated, never published) | Silent no-ops |
| **`SHOWCASE_LEFT_OPEN` is a proxy** | bound to the generic model's `gate_open`/`gate_closed` | False positives expected |
| **No trained jewellery model** | `training/` is a scaffold with empty `dataset/**` | Uses the generic `yolov10.onnx` |
| **Acknowledge / resolve** | no endpoint | `status`, `acknowledged_by`, `acknowledged_at`, `resolved_at` exist on every alert and nothing writes them |
| **`frame_url` never rendered** | `JewelryDashboard.tsx` | API returns it; UI shows no thumbnail |
| **`/footfall` is misnamed** | it is hourly alert volume | Self-documented via a `note` field |
| **No per-camera filter in UI** | `?camera_name=` supported by the API, never passed | |
| **Hardcoded dashboard URLs** | `JewelryDashboard.tsx` | Not routed through `import.meta.env.VITE_*` like the rest of the app |
| **k8s live-view POST breaks** | `jewelry_reader.py` hardcodes `http://node_backend:5000` | Missing the `DEPLOYMENT_PLATFORM` handling `post_processor` has |

---

## 2. End-to-end flow

```
  RTSP camera
       │
       ▼
  <cam>-jewelry container                 dockerhubalgo/jewelry_container:latest
  aksha_backend/jewellary_usecase/        reads RTSP directly · YOLO + ByteTrack · 12 rules
       │
       │  Kafka: jewelry_results          schema_version 1.0, one msg per rule fire
       ▼
  jewelry_alert_consumer.py               group alert-service-jewelry-group
       │                                  pure field bridge — applies NO rules
       │  Kafka: post_processing          + alert_type: "jewelry"
       ▼
  post_processor/app/main.py              3-way batch dispatch on alert_type
       ├──▶ Mongo  meta_jewelry_<cam>     every rule event
       ├──▶ Mongo  alerts                 alert_type: "JEWELRY_<RULE>"   ← the dashboard contract
       └──▶ Kafka  notification_service   Type: "Jewelry Alert"
       │
       ▼
  node_backend :5000                      routes/jewelryDashboard.ts
  GET /api/jewelry/dashboard/{summary,alerts,footfall}
       │
       ▼
  react_frontend :3000                    container/jewelryDashboard/JewelryDashboard.tsx
```

---

## 3. Detection pipeline

`aksha_backend/jewellary_usecase/`

| File | Lines | Role |
|---|---|---|
| `app/main.py` | 49 | argparse entrypoint **with env fallbacks** |
| `app/jewelry_detection.py` | 108 | model load, `detect_and_track`, `GreedyIoUTracker` |
| `app/jewelry_zones.py` | 136 | `Zone`, `Line`, `build_geometry` |
| `app/jewelry_rules.py` | 557 | `CFG`, `SEVERITY`, `AlertBus`, 12 rules |
| `app/jewelry_reader.py` | 238 | RTSP capture loop |
| `app/yolov10.onnx` | 9.3 MB | generic model, committed to git |
| `app/jewelry_labels.txt` | 13 | **dead file** — nothing reads it |

**Dependencies** (`requirements.txt`):
```
opencv-python-headless==4.10.0.84
ultralytics==8.3.0          # chosen over raw onnxruntime specifically for ByteTrack
onnxruntime==1.19.2
kafka-python==2.0.2
requests==2.32.3
numpy<2
```

### Entrypoint arguments

Each has an env fallback so **one image runs under both controllers** (Docker passes CLI flags, Kubernetes passes env):

| Flag | Env | Default |
|---|---|---|
| `--camera_name` | `CAMERA_NAME` | required |
| `--rtsp_id` | `RTSP_ID` | required — *accepted then never used* |
| `--rtsp_url` | `RTSP_URL` | required |
| `--output_width` / `--output_height` | `OUTPUT_WIDTH` / `OUTPUT_HEIGHT` | 640 / 360 |
| `--fps` | `FPS` | 1.0 |
| `--prefilter_threshold` | `SSIM_THRESH` | 0.95 — *accepted then never used* |

Also reads `AKSHA_PATH` and `KAFKA_BOOTSTRAP_SERVERS`.

### Zones and lines — `jewelry_zones.py`

Normalised 0–1 polygons, denormalised per camera frame size.

```python
DEFAULT_ZONES = { "staff_side": role "restricted",
                  "gold_counter_front": role "loiter",
                  "billing_queue": role "queue" }
DEFAULT_LINES = { "counter_boundary": role "counter_jump", alert_on "a_to_b",
                  "entrance":         role "footfall",     alert_on None }
ZONE_SETS = { "default": {...} }        # ← the only layout that exists
```
`Line.crossed(p_prev, p_now)` → `"a_to_b" | "b_to_a" | None` via segment intersection.
Helpers: `foot_point(box)` (bottom-centre — used for zone membership), `box_centre`, `iou`.

### Rules — `jewelry_rules.py`

```python
TOPIC = "jewelry_results"

CFG = { conf_threshold 0.25, iou_threshold 0.50, imgsz 640,
        business_hours {"open":"10:00","close":"20:30"},
        helmet_sustain_frames 3, loiter_seconds 8.0,
        queue_min_people 3, queue_sustain_seconds 4.0,
        open_state_seconds 8.0, bag_unattended_seconds 8.0,
        bag_unattended_radius_px 180, fall_sustain_frames 5,
        occupancy_alert_threshold 12, tamper_blur_var 45.0,
        tamper_dark_mean 28.0, tamper_scene_corr 0.35,
        tamper_sustain_frames 8, offline_timeout_s 5.0,
        min_healthy_fps 5.0, alert_cooldown_s 10.0 }
```

| Rule class | `rule` emitted | Severity | Trigger |
|---|---|---|---|
| `AfterHoursIntrusionRule` | `AFTER_HOURS_INTRUSION` | CRITICAL | any person outside business hours |
| `HelmetIndoorsRule` | `FACE_CONCEALMENT_INDOORS` | CRITICAL | `helmet` class sustained 3 frames |
| `CounterJumpRule` | `COUNTER_JUMP` | CRITICAL | foot point crosses line in `alert_on` direction |
| `CameraTamperRule` | `CAMERA_TAMPERING` | CRITICAL | Laplacian var / mean intensity / histogram corr, 8-frame streak |
| *(from the reader)* | `CAMERA_OFFLINE` | CRITICAL | grab gap > 5 s, or mean FPS < 5.0 |
| `OpenStateTimerRule` | `SHOWCASE_LEFT_OPEN` | HIGH | fixture open ≥ 8 s (proxy on `gate_open`) |
| `OpenStateTimerRule` | `CASH_DRAWER_OPEN` | HIGH | **never fires** — `class_map` → `None` |
| `OpenStateTimerRule` | `SAFE_DOOR_OPEN` | HIGH | **never fires** — `class_map` → `None` |
| `ZoneDwellRule` | `RESTRICTED_AREA_ENTRY` | HIGH | dwell ≥ 0.4 s in `restricted` zone |
| `FallDetectionRule` | `PERSON_FALL` | HIGH | `supine person` class, 5-frame streak |
| `UnattendedBagRule` | `BAG_LEFT_BEHIND` | HIGH | bag static ≤40 px, no person within 180 px, 8 s |
| `ZoneDwellRule` | `LOITERING` | MEDIUM | dwell ≥ 8 s in `loiter` zone (decays 2× dt outside) |
| `QueueRule` | `QUEUE_BUILDUP` | MEDIUM | ≥3 people sustained 4 s |
| `OccupancyDwellRule` | `OCCUPANCY_EXCEEDED` | MEDIUM | distinct track ids > 12 |
| `FootfallRule` | `FOOTFALL` | — | **never fires** — counts accumulated, never published |

`AlertBus._cooldown_ok(alert_type, subject, t_now)` gates on `alert_cooldown_s` (10 s) keyed `(alert_type, subject)`.

### `jewelry_results` message schema

```python
{
  "schema_version": "1.0",
  "event_id":    str(uuid4()),
  "camera_name": str,
  "rule":        str,                      # "LOITERING" — deliberately not "alert_type"
  "severity":    str,                      # lowercased
  "confidence":  float,                    # 3dp
  "track_id":    int | None,
  "zone":        str | None,
  "bbox":        [x1,y1,x2,y2] | None,
  "frame_id":    int,                      # frame index
  "timestamp":   str,                      # isoformat
  "frame":       str | None,               # base64 JPEG, full frame
  "metadata":    dict,                     # rule-specific
}
```

### Capture loop — `jewelry_reader.py`

`read_jewelry_frames(camera_name, rtsp_id, video_path, fps, output_size)`:
1. Logger → `$AKSHA_PATH/<camera>/log/jewelry-reader.log` (midnight rotate, gzip, 30 backups)
2. Load `yolov10.onnx`, resolve role ids, log `[OK]`/`[MISS]` per role
3. `build_geometry("default", w, h)` + `arm_rules(...)`, create `AlertBus` + tracker
4. Outer `while True` reopens `cv2.VideoCapture`; inner loop `cap.grab()` with `skip_rate = round(video_fps / fps)`
5. Per processed frame: resize → `detect_and_track` → `FrameContext` → `rule.update(ctx)` (exceptions caught **per rule**)
6. Write annotated frame to `$AKSHA_PATH/<camera>/live/workday.jpg` and `holiday.jpg`, POST both to `http://node_backend:5000/api/monitor/` on daemon threads

---

## 4. Alertification

`aksha_backend/alert_identification/jewelry_alert_consumer.py` (137 lines)

- Consumes `jewelry_results`, `group_id="alert-service-jewelry-group"`, `max_poll_records=1`, aiokafka
- **Applies no rules** — pure field-renaming bridge; all logic lives upstream in `AlertBus`
- **Writes nothing to Mongo**
- Produces to `post_processing`, key = `camera_name.encode("utf-8")`:

```python
{ "alert_type": "jewelry",           # pipeline dispatch tag
  "camera_name", "rule", "severity", "confidence",
  "track_id", "zone", "bbox", "metadata", "frame" }
```

Dropped: `schema_version`, `event_id`, `frame_id`, `timestamp` (post-processor re-stamps).
Runs as a **separate process** from `main.py` deliberately — avoids aiokafka coordinator/rebalance failures.

---

## 5. Post-processor

`aksha_backend/post_processor/app/main.py` (2198 lines)

| Addition | ~Line |
|---|---|
| `JewelryProcessingResult(camera_name, alert_dir, frame_file)` | 204 |
| `StreamResult` gains `rule`, `zone`, `track_id`, `bbox`, `metadata` | 322–326 |
| `self._jewelry_meta_buffer` | 659 |
| `_flush_jewelry_meta_buffer()` → `insert_many(ordered=False)` | 750 |
| `process_jewelry_detection()` | 1331 |
| `_handle_jewelry_result()` | 1848 |
| 3-way batch split | 2106 |

```python
od_batch      = [sr for sr in to_process if sr.alert_type not in ("ppe","jewelry")]
ppe_batch     = [sr for sr in to_process if sr.alert_type == "ppe"]
jewelry_batch = [sr for sr in to_process if sr.alert_type == "jewelry"]
```

`process_jewelry_detection` base64-decodes `frame`, draws a rectangle + `f"{SEVERITY.upper()}: {rule}"` using `PPE_SEVERITY_COLORS`, writes to:
```
{AKSHA_PATH}/{camera}/alerts/{YYYY-MM-DD}/{YYYY-MM-DD HH:MM:SS.ff}_alert.jpg
```

**Supporting modules**
- `notif_filter.py` → `send_jewelry_notification(...)`, payload `Type: "Jewelry Alert"`, `description` = `f"{rule.replace('_',' ').title()} (severity: {severity})"` + zone
- `postfilter.py` → `jewelry_status_check(rule, ...)`, Redis key `jewelry_alert_<rule>`, 6 s window. Documented as *"dedup insurance against at-least-once Kafka redelivery, not a real behavioral cooldown"*

**Dependencies:** `opencv-python-headless`, `aiokafka==0.12.0`, `pymongo==4.10.0`, `redis==5.0.8`, `numpy==1.26.4`

---

## 6. Database / data flow

Two collections per event.

### `meta_jewelry_<camera>` — per-camera detail, capitalised keys

```js
{ Timestamp: Date, Rule: String, Zone: String|null, TrackId: Number|null,
  BBox: [Number]|null, Severity: String, Metadata: Object, AlertImage: String|null }
```

### `alerts` — the shared dashboard contract, lowercase keys

```js
{ cam_name:         String,
  alert_type:       "JEWELRY_<RULE>",   // or "JEWELRY_UNKNOWN"
  severity:         String,
  metadata:         { rule, zone, track_id, bbox, ...stream_result.metadata },
  frame_path:       String|null,
  person_crop_path: null,               // always null
  timestamp:        Date,
  status:           "NEW",
  acknowledged_by:  null,
  acknowledged_at:  null,
  resolved_at:      null }
```

⚠️ **Three naming traps**
1. `alerts` (lowercase) = fired alerts, written raw by Python, **no Mongoose schema**.
2. `Alerts` (capital A) = user-defined alert *rules*, `models/myAlertSchema.ts`. Different collection.
3. `post_processor` also holds `self.collection = db['Alerts']` — that is the capital-A config collection, not the alert feed.

PPE writes this **identical shape** with `alert_type: "PPE_VIOLATION"`, which is why one dashboard pattern serves both.

---

## 7. Backend API

`AkshaV2-UIUX/backend/src/routes/jewelryDashboard.ts` (136 lines)
Registered at `appRoutes.ts:82` → `appRoutes.use("/api", jewelryDashboardRoutes, apiTimeOut)`

**Gate** — the only one:
```ts
function requireJewelryFlag(req, res, next) {
  if (process.env.JEWELRY_DETECTION !== "true")
    return res.status(403).json({ success:false, message:"Jewelry detection is not enabled" });
  next();
}
```

> ⚠️ **No JWT.** `appRoutes.ts` lines 66–68 (the JWT middleware) are **commented out repo-wide**, so no `/api` route is authenticated today. The frontend still calls through `axiosJWT`. Write new routes as if auth were on; do not describe these as authenticated.

Helpers: `alertsCollection()` → `mongoose.connection.db.collection("alerts")`; `frameUrl(p)` strips `AKSHA_PATH` → `${PROTOCOL}://${HOST}:${PORT}/${relative}`.

### API 1 — Summary

```
GET /api/jewelry/dashboard/summary
Env override: JEWELRY_DASHBOARD_SUMMARY (defined nowhere → default always applies)
Auth: none today · Gated by: JEWELRY_DETECTION
Handled by: routes/jewelryDashboard.ts   Called by: JewelryDashboard.tsx
Params: none
```
**Request**
```bash
curl http://localhost:5000/api/jewelry/dashboard/summary
```
**Response 200**
```json
{ "success": true,
  "summary": { "active_alerts": 12, "alerts_today": 47, "critical_active": 3,
               "by_severity": { "critical": 3, "high": 6, "medium": 3, "low": 0 } } }
```
**403** `{"success":false,"message":"Jewelry detection is not enabled"}`
**500** `{"success":false,"message":"unable to fetch jewelry dashboard summary"}`

Queries: `active_alerts` = `{alert_type:/^JEWELRY_/, status:"NEW"}`; `alerts_today` = `timestamp >= startOfToday`; `critical_active` adds `severity:/^critical$/i`; `by_severity` = `$group` on `{$toLower:"$severity"}` over `status:"NEW"`.

### API 2 — Alerts

```
GET /api/jewelry/dashboard/alerts?limit=20&camera_name=GATE_1
limit: default 25, capped 100 · camera_name: optional → cam_name
```
**Request**
```bash
curl "http://localhost:5000/api/jewelry/dashboard/alerts?limit=20"
```
**Response 200**
```json
{ "success": true,
  "alerts": [
    { "id": "6712ab…", "camera_name": "GATE_1", "rule": "LOITERING",
      "severity": "medium", "zone": "gold_counter_front",
      "timestamp": "2026-09-23T10:14:22.000Z", "status": "NEW",
      "frame_url": "http://host:5000/GATE_1/alerts/2026-09-23/2026-09-23 10:14:22.10_alert.jpg" } ] }
```
`rule` = `alert_type` with `JEWELRY_` stripped. Sorted `timestamp: -1`.

### API 3 — Footfall *(misnamed — hourly alert volume)*

```
GET /api/jewelry/dashboard/footfall        fixed last 24 h, no params
```
**Response 200**
```json
{ "success": true,
  "note": "Hourly alert volume, not true footfall — …",
  "hourly": [ { "hour": 0, "alert_count": 2 }, { "hour": 1, "alert_count": 0 } ] }
```
`$group` on `{$hour: "$timestamp"}`.

### Supporting APIs (not jewellery-specific)

```
GET /api/feature-flags              → { success, PPE_DETECTION: bool, JEWELRY_DETECTION: bool }
GET /api/object-labels?use_case=jewelry   → reads ${AKSHA_PATH}/labels_jewelry.txt
POST /api/camera/create             → accepts Detection_Type; 403 if the flag is off
PUT  /api/camera/update/:id         → same gate; restarts the camera
```

---

## 8. Camera wiring

```ts
// routes/cameras.ts:63
const DETECTION_TYPE_TO_DEPLOYMENT_MODE = { standard: undefined, ppe: "ppe", jewelry: "jewelry" };
// standard → undefined so the controller's own default applies unchanged

// resolveDeploymentMode(detectionType) -> { ok, deployment_mode?, message? }
//   unknown             → "Unknown Detection_Type: <x>"
//   jewelry, flag off   → "Jewelry detection is not enabled"   (403)
```
```ts
// models/configSchema.ts — collection "config"
Detection_Type: { type: String, enum: ["standard","ppe","jewelry"], default: "standard" }
PPE_Detection:  { type: Boolean, default: false }   // legacy, retained
```
```ts
// functions/serviceApiCamera.ts — already generic, needs no change per use case
...(deployment_mode ? { deployment_mode } : {}),   // POST http://API_SERVICE:4000/Surveillance, 70s timeout
```

Mirrored in Go: `backend-go/internal/routes/cameras.go`, `internal/config/config.go`.

---

## 9. Controller

`aksha_backend/controller/app/main.py`

- `safe_delete_jewelry(client, name)` — stops + removes `f"{name}-jewelry"`, tolerates `NotFound`
- `create_jewelry_deployment_object(client, item)`:
  - command `["python3","app/main.py","--camera_name",…,"--rtsp_url",…,"--fps",…]`
  - env `KAFKA_BOOTSTRAP_SERVERS`, `AKSHA_PATH=/Aksha`, `FPS`, `SSIM_THRESH`
  - volumes `HOST_MACHINE_AKSHA:/Aksha:rw`, `/etc/timezone:ro`, `/etc/localtime:ro`
  - `network="aksha-net"`, `restart_policy={"Name":"always"}`
  - **GPU-request-then-CPU-fallback**: tries `device_requests=[DeviceRequest(count=-1, capabilities=[["gpu"]])]`, retries plain on `APIError`
  - then `update_rtsp_status(..., deployment_mode="jewelry")`
- `camera_pod(surv)` has a `jewelry` branch in **all four** paths: start ×2, restart (including the rename case), stop
- Restart sweep suffix list is now `["-rtsp","-ppe","-jewelry","-anomaly","-face","-anpr"]` — before PR #31 the `-jewelry` container was silently skipped by `POST /Notifications`

**Kubernetes** — `controller_kubernetes/app/main.py`: `start_jewelry`, `stop_jewelry`, `restart_jewelry`, with `gpu=False` deliberately (claims no `nvidia.com/gpu` limit so the pod schedules anywhere).

---

## 10. Frontend

### Design system — connect to it, don't reinvent it

`src/styles/_tokens.scss` — plain CSS custom properties so any of the ~30 scattered partials can consume them without an `@use` chain. Imported once in `index.scss`.

```scss
--color-primary: #035faa;   --color-primary-dark: #024578;  --color-primary-tint: #e3edf7;
--color-success: #27ae60;   --color-danger: #dc3545;        --color-warning: #f5a623;
--color-bg: #f5f7fb;        --color-surface: #ffffff;       --color-border: #e3e7ed;
--color-text: #111827;      --color-text-muted: #6c7689;    --color-text-subtle: #9aa3b2;
--color-table-header: #495057;                              // every data table
--radius-sm|md|lg|pill      --shadow-sm|md|lg               --space-xs…xl
```
Breakpoints `1440 / 1200 / 992 / 768 / 480`. Shared partials `_classyTable.scss`, `_forms.scss`, `_modals.scss`.
Stack: MUI 5 + Ant 4 + Bootstrap 5 + Tailwind + `react-chartjs-2`, Inter.

⚠️ **`JewelryDashboard.tsx` does not follow this** — it hardcodes `#035faa` and a local `SEVERITY_COLOR` map. When you extend it, move to `var(--color-primary)` and the semantic tokens.

### Files

| File | Role |
|---|---|
| `context/FeatureFlagsContext.tsx` | One `axiosJWT.get('/api/feature-flags')` on mount (`[]` deps, no polling). `DEFAULT_FLAGS` all `false` — **fails closed**. `useFeatureFlags()` |
| `App.tsx` | `<AuthProvider><FeatureFlagsProvider>…</FeatureFlagsProvider></AuthProvider>` |
| `container/jewelryDashboard/JewelryDashboard.tsx` | 196 lines — the dashboard |
| `container/jewelryDashboard/jewelryDashboard.scss` | 90 lines |
| `header/headerData.ts` | nav entry `{ name:"Jewelry Dashboard", pageUrl:"/jewelry-dashboard", featureFlag:"JEWELRY_DETECTION" }` (reuses the Insights icon) |
| `header/Header.tsx` | `visiblePages()` filter; `handleRouteChange` matches **by `pageUrl`** |
| `router/Router.tsx` | `<Route path="/jewelry-dashboard" element={<JewelryDashboard />} />` |
| `container/cameraDirectory/List/Add.tsx` | Detection Type `<select>` |

### Frontend → backend integration

```ts
const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

const { JEWELRY_DETECTION } = useFeatureFlags();
if (!JEWELRY_DETECTION) return <p>Jewelry detection is not enabled for this deployment.</p>;

useEffect(() => {
  const load = async () => {
    const [s, a, f] = await Promise.all([
      axiosJWT.get(`${VITE_base_url}/api/jewelry/dashboard/summary`),
      axiosJWT.get(`${VITE_base_url}/api/jewelry/dashboard/alerts?limit=20`),
      axiosJWT.get(`${VITE_base_url}/api/jewelry/dashboard/footfall`),
    ]);
    …
  };
  load();
  const id = setInterval(load, 30000);
  return () => clearInterval(id);
}, [JEWELRY_DETECTION]);
```

**Two conventions exist.** Older screens (`cameraGroup`, `cameraDirectory`) use the `useApi()` hook; `JewelryDashboard.tsx` — the newest — uses `axiosJWT` directly. Both carry the JWT interceptor. Never call bare `axios` from a component.

### Dashboard layout

4 KPI tiles (Active Alerts / Alerts Today / Critical Active / By Severity chips) → Alert Volume (last 24 h) `<Bar>` chart → Recent Alerts feed.
Chart registers `CategoryScale, LinearScale, BarElement, Tooltip, Legend`; labels `${h.hour}:00`.
`SEVERITY_COLOR = { critical:"#d64545", high:"#e08a2f", medium:"#d6b53a", low:"#4a8f5c" }`.
`marginTop: 68` clears the fixed header.

---

## 11. Configuration

```yaml
# deployment/docker-compose.yml — node_backend.environment
JEWELRY_DETECTION: "false"      # shipped OFF; flip to "true" for the pilot

# new service — reuses the alert_identification image, no new build required
jewelry_alert_consumer:
  image: dockerhubalgo/alert_identification:03072026-2
  command: ["python", "jewelry_alert_consumer.py"]
  depends_on: { kafka_broker: { condition: service_started } }
  environment: { KAFKA_BOOTSTRAP_SERVERS: broker:9092, AKSHA_PATH: /Aksha }
```
There is **no compose service for the per-camera jewellery container** — the controller spawns it on demand.

`deployment/Aksha/labels_jewelry.txt` — 14 human-readable rule names, served by `GET /api/object-labels?use_case=jewelry`.

---

## 12. Testing

**Backend** — Jest + supertest, `AkshaV2-UIUX/backend/tests/routes/<name>.test.ts`. Mount the router on a bare express app and mock the data layer:
```ts
import request from "supertest";
import express from "express";
import jewelryDashboard from "../../src/routes/jewelryDashboard";
const app = express();
app.use("/api", jewelryDashboard);

it("403s when the flag is off", async () => {
  delete process.env.JEWELRY_DETECTION;
  const res = await request(app).get("/api/jewelry/dashboard/summary");
  expect(res.status).toBe(403);
});
```
Run: `cd AkshaV2-UIUX/backend && npm test`

**Go** — `backend-go/internal/routes/*_test.go`, run `go test ./...`
**Frontend** — `cd AkshaV2-UIUX/frontend && npm test` (Jest)

**Manual end-to-end**
1. `JEWELRY_DETECTION: "true"` in compose → `docker compose up -d node_backend`
2. Create a camera with Detection Type = Jewelry → confirm `<cam>-jewelry` in `docker ps`
3. `docker logs --tail 100 <cam>-jewelry` → expect `[OK]`/`[MISS]` role lines and FPS logs every 10 s
4. `docker logs --tail 50 jewelry_alert_consumer` → messages bridging to `post_processing`
5. `mongosh` → `db.alerts.find({alert_type:/^JEWELRY_/}).sort({timestamp:-1}).limit(5)`
6. `curl localhost:5000/api/jewelry/dashboard/summary`
7. Open `/jewelry-dashboard` — nav entry should be visible only with the flag on

---

## 13. Claude Code implementation prompt

> **Context.** Aksha v2.1, commit `f9ca20a3`. The jewellery use case is implemented end-to-end and is the reference for the platform: `aksha_backend/jewellary_usecase/` reads RTSP and publishes to Kafka `jewelry_results`; `alert_identification/jewelry_alert_consumer.py` bridges to `post_processing` with `alert_type: "jewelry"`; `post_processor/app/main.py` writes `meta_jewelry_<cam>` and dual-writes into the shared `alerts` collection as `alert_type: "JEWELRY_<RULE>"`; `backend/src/routes/jewelryDashboard.ts` exposes three GET endpoints gated by `requireJewelryFlag`; `container/jewelryDashboard/JewelryDashboard.tsx` renders them. The flag `JEWELRY_DETECTION` ships `"false"`.
>
> **Task.** Close the verified gaps, in this order. Stop after each for review.
>
> **1. Acknowledge / resolve.** Every alert document already carries `status`, `acknowledged_by`, `acknowledged_at`, `resolved_at`, and nothing writes them. Add `POST /api/jewelry/dashboard/alerts/:id/acknowledge` and `POST /api/jewelry/dashboard/alerts/:id/resolve` to `routes/jewelryDashboard.ts`, behind the same `requireJewelryFlag`, using `alertsCollection().updateOne({_id: new ObjectId(id)}, {$set:{…}})`. Add buttons to the alert feed in `JewelryDashboard.tsx`. Add supertest cases in `backend/tests/routes/jewelryDashboard.test.ts` covering flag-off 403, bad ObjectId 400, and success.
>
> **2. Render `frame_url`.** The API already returns it and the UI ignores it. Add a thumbnail to each row of the Recent Alerts feed, with a click-to-enlarge using the existing `component/common/ImageZoomModal.tsx` rather than a new modal.
>
> **3. Move to design tokens.** `JewelryDashboard.tsx` hardcodes `#035faa` and a local `SEVERITY_COLOR` map. Replace with `var(--color-primary)` and the semantic tokens from `src/styles/_tokens.scss`. Keep the severity hues distinguishable — if the token set has no direct equivalent, add the four severity colours to `_tokens.scss` as `--color-severity-critical|high|medium|low` so PPE and ANPR dashboards can share them.
>
> **4. Per-camera zones.** `jewelry_zones.py` exposes only `ZONE_SETS = {"default": …}`, so every jewellery camera shares one store layout. Move the layout to per-camera config: add a zones field to the camera document (`models/configSchema.ts`), a `GET/PUT /api/jewelry/camera/:name/zones` pair, and have `jewelry_reader.py` fetch its layout at startup with the current `DEFAULT_ZONES` as fallback. For the editor, reuse the existing polygon-drawing component `component/common/CanvasDraw.tsx` — do not write a new canvas.
>
> **5. Fix or rename `footfall`.** `FootfallRule` in `jewelry_rules.py` accumulates `entries`/`exits` sets that nothing reads. Either publish those counts through `AlertBus` and make `/jewelry/dashboard/footfall` real, or rename the endpoint `alert-volume` and drop the apologetic `note` field. State which you chose and why.
>
> **6. Cross-cutting bug — fix this regardless.** `container/cameraDirectory/List/List.tsx` (~line 340) PUTs `/api/camera/update/:id` for the email/display-alert toggles **without** `Detection_Type`. The backend then writes `Detection_Type: "standard"` and passes `deployment_mode: undefined`, so flipping an alert switch on a jewellery camera silently converts it to a standard camera and restarts it. This affects PPE too.
>
> **Constraints.**
> - Do not add a Mongoose schema for the `alerts` collection — it is intentionally raw, shared with PPE, and written by Python.
> - Do not change the `jewelry_results` or `post_processing` message shapes; PPE and future use cases depend on the `alert_type` discriminator convention.
> - Any new route must also be added to `backend-go/internal/routes/` with identical JSON, or explicitly noted as Node-only.
> - `Header.tsx` must keep resolving the active tab by `pageUrl`, not array index — index-based lookup breaks when the flag-filtered nav array is shorter than `pages`.
> - Do not commit new model weights or video files; `app/yolov10.onnx` (9.3 MB) and three demo `.mp4`s are already in git.

---

## 14. Further reading

| File | Why |
|---|---|
| `JEWELRY-STORE-CV-DESIGN.md` | The client use cases behind the rules |
| `FULLSTACK-ONBOARDING-PPE.md` | Sibling use case — backend-complete, dashboard missing |
| `FULLSTACK-ONBOARDING-ANPR.md` | Sibling use case — prototype only |
| `aksha_backend/jewellary_usecase/app/jewelry_rules.py` | The rule-engine pattern |
| `aksha_backend/controller/app/main.py` | Every camera operation |
