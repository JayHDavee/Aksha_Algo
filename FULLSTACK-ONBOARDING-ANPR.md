# ANPR — Full-Stack Onboarding

**For:** a developer picking up automatic number-plate recognition in Aksha v2.1.
**Verified against:** commit `f9ca20a3`. Every claim below was read out of the source; the gaps were confirmed absent, not assumed.

> **Read this before planning any work.**
> ANPR is a **detector-only prototype**, not a use case. It reads plates and inserts raw rows into a per-camera Mongo collection, and stops there. It publishes nothing to Kafka, raises no alerts, has no backend route, no page, no feature flag, and is **not in `docker-compose.yml`**.
>
> It also **cannot be switched on from the UI at all** — the Node backend never sends the controller's `anpr` field, so it is always `false` in practice.
>
> Treat this document as a build plan, not a tour.

---

## 1. Status at a glance

### Already implemented

| Layer | Artefact |
|---|---|
| Plate detection | `aksha_backend/anpr/app/anpr.py` — ONNX, CPU-only |
| OCR | EasyOCR, with India-specific post-correction |
| Multi-line plates | `merge_multiline_text()` — y-centre grouping |
| Frame source | consumes Kafka `raw_frame` |
| Raw persistence | Mongo collection `<cam_name>_anpr` |
| Live view | POSTs frames to `/api/monitor/` |
| Controller spawn | `create_anpr_deployment()` → `<cam>-anpr`, image `anpr_service:latest` |
| Restart sweep | `-anpr` is in the `POST /Notifications` suffix list |

### Needs implementation

| Gap | Evidence | Severity |
|---|---|---|
| **No Kafka output** | `main.py:5` imports `KafkaProducer` and **never instantiates it**. No `anpr_results` topic exists | **blocker** |
| **No alertification** | no `anpr_alert_consumer.py` in `alert_identification/` | **blocker** |
| **No post-processor branch** | grep `anpr\|plate` in `post_processor/` → nothing | **blocker** |
| **No backend route** | grep `anpr\|plate` in `AkshaV2-UIUX/backend/src/` → **zero hits** | **blocker** |
| **Cannot be enabled from the UI** | backend never sends `anpr`; Pydantic `extra="ignore"` silently drops it | **blocker** |
| **No authorization logic** | no whitelist/blacklist anywhere — the "authorized vs unauthorized" concept does not exist in code | **blocker** |
| **No frontend** | no page, no nav entry, no Detection Type option | high |
| **No feature flag** | no `ANPR_DETECTION` anywhere in the repo | high |
| **Not in compose** | `grep anpr deployment/docker-compose.yml` → no matches; `anpr_service:latest` must be built by hand | high |
| **Docker name conflict on update** | see §9 | high |
| **No dedup** | same plate in consecutive frames → repeated inserts | medium |
| **Depends on `frame_reader`** | consumes `raw_frame` rather than reading RTSP, unlike PPE and jewellery | medium |
| **`labels_anpr.txt` has no rule names** | it currently holds detection classes, not alert types | low |
| **CPU-only, hardcoded** | `CPUExecutionProvider` and `easyocr.Reader(gpu=False)` | low |

---

## 2. End-to-end flow

### Today

```
  Kafka: raw_frame                        ← requires a frame_reader pipeline on the same camera
       │
       ▼
  <cam>-anpr container                    image anpr_service:latest (built by hand)
  aksha_backend/anpr/app/main.py          ONNX plate detect → EasyOCR → India-format correction
       │
       ├──▶ Mongo  <cam_name>_anpr        { Timestamp, CameraName, Detections }
       ├──▶ log    $AKSHA_PATH/log/<cam>_anpr.log
       └──▶ POST   /api/monitor/          live view
                    ✗ STOPS HERE
```

### Target — matching jewellery and PPE

```
  RTSP (or raw_frame — decide, §10)
       │
       ▼
  <cam>-anpr container
       │  Kafka: anpr_results             ← to build
       ▼
  anpr_alert_consumer.py                  ← to build
       │  Kafka: post_processing          + alert_type: "anpr"
       ▼
  post_processor  (4-way batch dispatch)  ← to build
       ├──▶ Mongo  meta_anpr_<cam>        every plate read
       ├──▶ Mongo  alerts                 alert_type: "ANPR_UNAUTHORIZED"
       └──▶ Kafka  notification_service   Type: "ANPR Alert"
       │
       ▼
  GET /api/anpr/dashboard/*               ← to build
       ▼
  container/anprDashboard/                ← to build
```

---

## 3. Detection pipeline — what exists

`aksha_backend/anpr/`

| File | Lines | Role |
|---|---|---|
| `app/anpr.py` | 228 | `NumberPlateRecognizerONNX` — detection + OCR + text post-processing |
| `app/main.py` | 177 | Kafka consumer loop, Mongo insert, live-view POST |
| `anpr.onnx` | — | plate detection model |
| `Dockerfile` | — | `CMD ["python", "app/main.py"]` |

**Dependencies** (`requirements.txt`):
```
opencv-python-headless==4.8.1.78
ultralytics==8.0.20
easyocr==1.7.0
numpy==1.24.4
pymongo==4.5.0
requests==2.32.0
kafka-python==2.0.2
onnxruntime==1.19.2
```
Note these are **older pins than the other services** (jewellery uses opencv 4.10 / onnxruntime 1.19.2 / numpy<2). Reconcile before adding it to compose.

### `anpr.py`

```python
class NumberPlateRecognizerONNX:
    def __init__(self, model_path, imgsz=640, conf=0.25):
        self.reader = easyocr.Reader(['en'], gpu=False)                    # CPU hardcoded
        self.session = ort.InferenceSession(model_path,
                       providers=['CPUExecutionProvider'])                  # CPU hardcoded
```

- `preprocess()` — letterbox to 640
- `postprocess()` — **defensive/heuristic**: guesses between several YOLO output layouts at runtime and prints debug per detection
- `merge_multiline_text()` — groups OCR boxes by y-centre (15 px threshold) for two-line Indian plates
- `postprocessing_text()` — **India-specific**: uppercases, strips `"IND"`, strips non-alphanumerics, and for 10-character plates applies positional correction using `ALPHA_MAP` / `DIGIT_MAP` at alpha indices `[0,1,4,5]` and digit indices `[2,3,6,7,8,9]` — i.e. the `AA00AA0000` format
- `detect(frame)` → `[{ bbox: [x1,y1,x2,y2], score: float, ocr_raw: str, ocr_post: str }, …]`

```python
ALPHA_MAP = {'0':'O','1':'I','2':'Z','3':'B','4':'A','5':'S','6':'G','7':'T','8':'B','9':'G'}
DIGIT_MAP = {'O':'0','I':'1','Z':'2','B':'8','S':'5','G':'6','T':'7','A':'4','L':'4'}
```
**Reuse these maps** for any whitelist comparison — do not write a second normaliser, or a plate will match in one place and not the other.

### `main.py`

- Consumes Kafka `raw_frame`, `group_id="anpr_group"`, `auto_offset_reset='latest'`
- Reads `camera_name` and `timestamp_str` from message **headers**; the frame is the raw message value (JPEG bytes)
- On detection: appends to `$AKSHA_PATH/log/<cam>_anpr.log`, inserts into Mongo, POSTs the frame to `http://node_backend:5000/api/monitor/` as `image_type="workday"`

---

## 4. Alertification — **missing**

`aksha_backend/alert_identification/` contains exactly `main.py`, `my_alert_filters.py`, `jewelry_alert_consumer.py`, `ppe_alert_consumer.py`. **There is no `anpr_alert_consumer.py`**, and `main.py` (the generic `object_detection_results` → `post_processing` consumer) has no ANPR branch.

**To build** — mirror `jewelry_alert_consumer.py`:
- consume `anpr_results`, `group_id="alert-service-anpr-group"`, `max_poll_records=1`
- add `"alert_type": "anpr"`, republish to `post_processing` keyed by camera name
- run as a **separate process** from `main.py` — both existing consumers do this deliberately to avoid aiokafka coordinator/rebalance failures
- add a compose service reusing `dockerhubalgo/alert_identification:03072026-2` with an overridden `command`, so **no new image build is needed**

---

## 5. Post-processor — **missing**

No ANPR handling anywhere in `aksha_backend/post_processor/`.

**To build**, following the jewellery additions:

| Piece | Model on |
|---|---|
| `AnprProcessingResult` dataclass | `JewelryProcessingResult` (~line 204) |
| `_anpr_meta_buffer` + `_flush_anpr_meta_buffer()` → `meta_anpr_<cam>` | `_flush_jewelry_meta_buffer` (~750) |
| `process_anpr_detection()` — annotate plate box, write JPEG | `process_jewelry_detection` (~1331) |
| `_handle_anpr_result()` — meta buffer + `alerts` dual-write + notification | `_handle_jewelry_result` (~1848) |
| Widen the batch split **3-way → 4-way** | ~line 2106 |
| `notif_filter.send_anpr_notification()` | `send_jewelry_notification` (`notif_filter.py:451`+) |
| `postfilter.anpr_status_check()` | `jewelry_status_check` (`postfilter.py`) |

Current split to extend:
```python
od_batch      = [sr for sr in to_process if sr.alert_type not in ("ppe","jewelry")]
ppe_batch     = [sr for sr in to_process if sr.alert_type == "ppe"]
jewelry_batch = [sr for sr in to_process if sr.alert_type == "jewelry"]
```
⚠️ Note `od_batch` is a **negative** filter — adding `"anpr"` without also adding it to that exclusion list will send every ANPR message down the object-detection path as well.

---

## 6. Database / data flow

### Today — `<cam_name>_anpr`

```js
{ Timestamp: ..., CameraName: String,
  Detections: [ { bbox, score, ocr_raw, ocr_post } ] }
```
Note the collection name uses a **lowercase suffix with an underscore** (`GATE_1_anpr`), unlike the meta collections the other use cases write (`meta_jewelry_GATE_1`, `meta_ppe_GATE_1`). Align on `meta_anpr_<cam>` when you build the post-processor path, and decide what happens to the legacy collection.

### Target — the shared `alerts` contract

Both working use cases write this identical shape, which is what makes one dashboard pattern serve all three:

```js
{ cam_name:         String,
  alert_type:       "ANPR_UNAUTHORIZED",
  severity:         String,
  metadata:         { plate, ocr_confidence, bbox, authorized: false, … },
  frame_path:       String|null,
  person_crop_path: null,
  timestamp:        Date,
  status:           "NEW",
  acknowledged_by:  null,
  acknowledged_at:  null,
  resolved_at:      null }
```

⚠️ Naming traps: lowercase `alerts` = fired alerts, written raw by Python, **no Mongoose schema**. Capital-A `Alerts` = user-defined alert rules (`models/myAlertSchema.ts`). Different collections.

### Whitelist storage — a decision to make

No whitelist exists. Options, in rough order of fit:
1. **New collection `anpr_whitelist`** — `{ plate, label, active, valid_from, valid_to }`. Cleanest; needs CRUD endpoints and a UI.
2. **Reuse `Alerts`** (the rule collection) — awkward; that schema is shaped around object classes and areas, not plate strings.
3. **File on `AKSHA_PATH`** — fastest to ship, worst to operate.

Whatever you pick, normalise on write using `anpr.py`'s `ALPHA_MAP`/`DIGIT_MAP` so lookups match.

---

## 7. APIs

### Existing

**None.** `grep -rn "anpr\|plate" AkshaV2-UIUX/backend/src/` returns **zero hits**.

### Missing — to build

New file `AkshaV2-UIUX/backend/src/routes/anprDashboard.ts`, modelled on `jewelryDashboard.ts`, registered in `appRoutes.ts`.

**1. Summary**
```
GET /api/anpr/dashboard/summary
Gate: requireAnprFlag → 403 when process.env.ANPR_DETECTION !== "true"
Handled by: routes/anprDashboard.ts    Called by: AnprDashboard.tsx
```
```json
{ "success": true,
  "summary": { "reads_today": 214, "unauthorized_today": 7,
               "active_alerts": 3, "unique_plates_today": 118 } }
```

**2. Plate reads**
```
GET /api/anpr/dashboard/reads?limit=20&camera_name=GATE_1&authorized=false
limit default 25, capped 100
```
```json
{ "success": true,
  "reads": [
    { "id": "6712ab…", "camera_name": "GATE_1",
      "plate": "MH12AB1234", "ocr_confidence": 0.91,
      "authorized": false, "severity": "high",
      "timestamp": "2026-09-23T10:14:22.000Z", "status": "NEW",
      "frame_url": "http://host:5000/GATE_1/alerts/2026-09-23/….jpg" } ] }
```

**3. Whitelist CRUD**
```
GET    /api/anpr/whitelist
POST   /api/anpr/whitelist          { "plate": "MH12AB1234", "label": "Director" }
DELETE /api/anpr/whitelist/:plate
```
```json
{ "success": true, "whitelist": [ { "plate": "MH12AB1234", "label": "Director", "active": true } ] }
```

### Existing APIs that must change

```
GET /api/feature-flags        → add ANPR_DETECTION
GET /api/object-labels?use_case=anpr   → reads ${AKSHA_PATH}/labels_anpr.txt  (file exists)
POST /api/camera/create       → must accept and forward the ANPR selection
PUT  /api/camera/update/:id   → same
```

---

## 8. Frontend

### Existing

**None.** `grep -rn "anpr\|plate" AkshaV2-UIUX/frontend/src/` returns only incidental CSS `grid-template-columns` matches. `Add.tsx` offers `standard` / `ppe` / `jewelry` only.

### Design system — connect to it

`src/styles/_tokens.scss`, plain CSS custom properties, imported once in `index.scss`:

```scss
--color-primary: #035faa;   --color-primary-dark: #024578;  --color-primary-tint: #e3edf7;
--color-success: #27ae60;   --color-danger: #dc3545;        --color-warning: #f5a623;
--color-bg: #f5f7fb;        --color-surface: #ffffff;       --color-border: #e3e7ed;
--color-text: #111827;      --color-text-muted: #6c7689;
--color-table-header: #495057;
--radius-sm|md|lg|pill      --shadow-sm|md|lg               --space-xs…xl
```
Breakpoints `1440 / 1200 / 992 / 768 / 480`. Shared partials `_classyTable.scss`, `_forms.scss`, `_modals.scss`.
Stack: MUI 5 + Ant 4 + Bootstrap 5 + Tailwind + `react-chartjs-2`, Inter.

A plate-read feed is a **table**, so use `_classyTable.scss` and `--color-table-header` rather than inventing a layout. ⚠️ Do not copy `JewelryDashboard.tsx`'s hardcoded `#035faa` and local `SEVERITY_COLOR` map — use the tokens.

### Files to create

```
src/container/anprDashboard/
  AnprDashboard.tsx        page — KPI tiles + plate-read table
  anprDashboard.scss
  WhitelistManager.tsx     optional — whitelist CRUD
```

### Files to modify

| File | Change |
|---|---|
| `context/FeatureFlagsContext.tsx` | **3 edits** — the `FeatureFlags` interface, `DEFAULT_FLAGS`, and the response mapping |
| `header/headerData.ts` | nav entry with `featureFlag: "ANPR_DETECTION"` |
| `router/Router.tsx` | `<Route path="/anpr-dashboard" element={<AnprDashboard />} />` |
| `container/cameraDirectory/List/Add.tsx` | the ANPR control — see §10 for why this is a checkbox, not an `<option>` |

### Frontend → backend integration

```ts
import axiosJWT from "../../context/axiosAuthIntercept";
import { useFeatureFlags } from "../../context/FeatureFlagsContext";

const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

const { ANPR_DETECTION } = useFeatureFlags();
if (!ANPR_DETECTION) return <p>ANPR is not enabled for this deployment.</p>;
```
Follow the jewellery convention (`axiosJWT` + `Promise.all` + `setInterval(load, 30000)` with cleanup). Older screens use the `useApi()` hook; both carry the JWT interceptor. Never call bare `axios` from a component.

⚠️ `Header.tsx` resolves the active tab **by `pageUrl`**, not array index. Do not regress that — it is what allows a flag-filtered nav array to be shorter than `pages`.

---

## 9. Controller — and the bug to fix first

`aksha_backend/controller/app/main.py`

```python
anpr: bool = False                                   # line 133 — an ADD-ON, not a deployment_mode
def create_anpr_deployment(client, cam):             # line 815
    name=f"{cam}-anpr", image="anpr_service:latest", network="aksha-net"
```

ANPR fires alongside whatever `deployment_mode` is set, exactly like `face_rec`:
```python
if it.face_rec: create_face_rec_deployment(client, it.camera_name)
if it.anpr:     create_anpr_deployment(client, it.camera_name)     # lines 891 (create) and 918 (update)
```

### ⚠️ Docker name conflict on update

```python
elif it.deployment_mode == "ppe":      safe_delete_ppe(client, …)      # removes ONLY -ppe
elif it.deployment_mode == "jewelry":  safe_delete_jewelry(client, …)  # removes ONLY -jewelry
else:                                  safe_delete(client, …)          # removes -rtsp/-anomaly/-face/-anpr
if it.anpr: create_anpr_deployment(client, …)                          # no delete of -anpr first
```

`safe_delete()` (the standard path) **does** remove `-anpr`, so a standard camera re-creates cleanly. But `safe_delete_ppe` and `safe_delete_jewelry` remove only their own container — so updating a **PPE or jewellery camera that also has ANPR** leaves the old `-anpr` running and `create_anpr_deployment` hits a Docker 409.

**Fix:** add `safe_delete_anpr(client, name)` (mirroring `safe_delete_ppe` at line 528) and call it immediately before `create_anpr_deployment` in both the create and update paths. Mirror in `controller_kubernetes/app/main.py`.

Good news: the restart sweep already knows about it — `["-rtsp","-ppe","-jewelry","-anomaly","-face","-anpr"]`.

---

## 10. Three design decisions to make before coding

**1. Mode or add-on?**
`Detection_Type` is `enum: ["standard","ppe","jewelry"]` — mutually exclusive. But a plate reader can legitimately run *alongside* PPE on the same camera, and the controller already models ANPR as a composable boolean like `face_rec`.
→ **Recommended:** keep it a boolean. Add `ANPR_Detection: { type: Boolean, default: false }` to `configSchema.ts`, a checkbox in `Add.tsx`, and forward `anpr: true` in `serviceApiCamera.ts`. Extending the enum would force users to choose between PPE and plate reading.

**2. `raw_frame` or direct RTSP?**
ANPR is the only use case that consumes `raw_frame`, so an ANPR camera must **also** run a `frame_reader` pipeline. PPE and jewellery read RTSP themselves.
→ Converting it aligns the architecture and removes the hidden dependency; keeping it saves work now. **Decide explicitly and write it down** — do not change it silently.

**3. Where does the whitelist live?** See §6.

---

## 11. Configuration

### To add

```yaml
# deployment/docker-compose.yml — node_backend.environment
ANPR_DETECTION: "false"        # default off, like JEWELRY_DETECTION

# new service, reusing the alert_identification image
anpr_alert_consumer:
  image: dockerhubalgo/alert_identification:03072026-2
  networks: [aksha-net]
  restart: always
  command: ["python", "anpr_alert_consumer.py"]
  depends_on: { kafka_broker: { condition: service_started } }
  environment: { KAFKA_BOOTSTRAP_SERVERS: broker:9092, AKSHA_PATH: /Aksha }
```

There is **no compose service for the per-camera `<cam>-anpr` container** — nor should there be; the controller spawns it, as with PPE and jewellery. But `anpr_service:latest` is currently built by hand, unlike `ppe_container` and `jewelry_container` which have `exec_script.sh`. Add one.

### `deployment/Aksha/labels_anpr.txt`

Exists, and the name is correct — `GET /api/object-labels?use_case=anpr` reads `labels_${use_case}.txt`. It currently holds detection class names. Compare with `labels_jewelry.txt`, which holds **human-readable rule names** (`After-Hours Intrusion`, `Loitering`, …). If you add ANPR alert types, this file should hold those, not model classes.

---

## 12. Testing

**Backend** — Jest + supertest, `AkshaV2-UIUX/backend/tests/routes/anprDashboard.test.ts`:
```ts
import request from "supertest";
import express from "express";
import anprDashboard from "../../src/routes/anprDashboard";

const app = express();
app.use(express.json());
app.use("/api", anprDashboard);

it("403s when the flag is off", async () => {
  delete process.env.ANPR_DETECTION;
  const res = await request(app).get("/api/anpr/dashboard/summary");
  expect(res.status).toBe(403);
});
```
Run: `cd AkshaV2-UIUX/backend && npm test`. Copy `tests/routes/cameras.test.ts`.

**Pipeline** — no test harness exists for `anpr/`. Worth adding a unit test for `postprocessing_text()`, which has real logic and is easy to test:
```python
assert postprocessing_text("IND MH12AB1234") == "MH12AB1234"
assert postprocessing_text("MHI2AB1234")     == "MH12AB1234"   # I→1 at digit index 2
```

**Manual end-to-end** — ANPR is not in compose, so start here:
1. Build it: `cd aksha_backend/anpr && docker build -t anpr_service:latest .`
2. Confirm a `frame_reader` is running for the camera (ANPR needs `raw_frame`)
3. Start the container by calling the controller directly — **this cannot be done from the UI today**:
   ```bash
   curl -X POST http://localhost:4000/Surveillance -H 'Content-Type: application/json' \
     -d '{"type":"start","camera_list":[{"camera_name":"GATE_1","rtsp_link":"rtsp://…","rtsp_id":1,"anpr":true}]}'
   ```
4. `docker ps | grep anpr` → expect `GATE_1-anpr`
5. `docker logs --tail 100 GATE_1-anpr`
6. `mongosh` → `db.GATE_1_anpr.find().sort({Timestamp:-1}).limit(5)`
7. After building the Kafka path: `db.alerts.find({alert_type:"ANPR_UNAUTHORIZED"})`

---

## 13. Claude Code implementation prompt

> **Context.** Aksha v2.1, commit `f9ca20a3`. ANPR is a detector-only prototype. `aksha_backend/anpr/app/main.py` consumes Kafka `raw_frame` (group `anpr_group`), runs an ONNX plate detector plus EasyOCR (`anpr.py`, both CPU-hardcoded), and inserts raw rows into Mongo `<cam_name>_anpr`. Verified gaps: it imports `KafkaProducer` on line 5 and **never instantiates it**, so there is no `anpr_results` topic; there is no `anpr_alert_consumer.py`; there is no ANPR branch in the post-processor; `grep -rn "anpr" AkshaV2-UIUX/backend/src/` returns **zero hits**; there is no frontend, no `ANPR_DETECTION` flag, and no compose entry. The controller exposes `anpr: bool = False` as a composable add-on (like `face_rec`, not a `deployment_mode`), but since the backend never sends that field and Pydantic uses `extra="ignore"`, ANPR **cannot be enabled from the UI at all**.
>
> The working references are jewellery (`aksha_backend/jewellary_usecase/` → `routes/jewelryDashboard.ts` → `container/jewelryDashboard/`) and PPE. Both converge on Kafka `post_processing` with an `alert_type` discriminator and dual-write into the shared `alerts` collection.
>
> **Task.** Bring ANPR to the same standard. Work in this order and **stop after each step for review** — this is a multi-day change, not one commit.
>
> **Step 0 — decide and document three things** before writing code, in a short design note at the top of your first PR:
> a) **Mode or add-on.** Recommended: keep it a composable boolean (`ANPR_Detection` on `configSchema.ts`) rather than extending the `Detection_Type` enum, because a plate reader can legitimately run alongside PPE and the controller already models it that way.
> b) **`raw_frame` or direct RTSP.** ANPR is the only use case consuming `raw_frame`, so it needs a `frame_reader` on the same camera. PPE and jewellery read RTSP themselves. State which you are doing and why; do not change it silently.
> c) **Where the whitelist lives.** Recommended: a new `anpr_whitelist` collection.
>
> **Step 1 — Kafka output.** Give `anpr/app/main.py` a producer publishing to `anpr_results`, following `jewelry_rules.AlertBus.emit`'s schema (`schema_version`, `event_id`, `camera_name`, `rule`, `severity`, `confidence`, `bbox`, `frame_id`, `timestamp`, `frame` base64, `metadata`). Put the plate string and OCR confidence in `metadata`. Add a dedup window so the same plate on consecutive frames emits once — model it on `postfilter.ppe_status_check`'s Redis approach.
>
> **Step 2 — Authorization.** Add the whitelist lookup so each read yields authorized/unauthorized. **Reuse `anpr.py`'s existing `ALPHA_MAP`/`DIGIT_MAP` normalisation** — do not write a second normaliser, or plates will match in one place and not the other. Emit `rule: "ANPR_UNAUTHORIZED"` only for non-whitelisted plates; authorized reads go to the meta collection only.
>
> **Step 3 — Alertification.** Create `alert_identification/anpr_alert_consumer.py` mirroring `jewelry_alert_consumer.py` (group `alert-service-anpr-group`, adds `alert_type: "anpr"`, republishes to `post_processing`, runs as a separate process). Add the compose service reusing `dockerhubalgo/alert_identification:03072026-2` with an overridden `command` — no new image build.
>
> **Step 4 — Post-processor.** Add `AnprProcessingResult`, `_anpr_meta_buffer` / `_flush_anpr_meta_buffer()` → `meta_anpr_<cam>`, `process_anpr_detection()`, and `_handle_anpr_result()` with the `alerts` dual-write using `alert_type: "ANPR_UNAUTHORIZED"`. Widen the batch split at ~line 2106 from 3-way to 4-way — **and note `od_batch` is a negative filter (`alert_type not in ("ppe","jewelry")`), so `"anpr"` must be added there too** or every ANPR message will also go down the object-detection path. Add `notif_filter.send_anpr_notification()` and `postfilter.anpr_status_check()`.
>
> **Step 5 — Fix the controller name-conflict bug.** `safe_delete_ppe` and `safe_delete_jewelry` remove only their own container, while `create_anpr_deployment` runs unconditionally after them — so updating a PPE or jewellery camera that also has ANPR hits a Docker 409 on the still-running `-anpr` container. Add `safe_delete_anpr(client, name)` mirroring `safe_delete_ppe` (line 528) and call it before `create_anpr_deployment` in both the create and update paths. Mirror in `controller_kubernetes/app/main.py`.
>
> **Step 6 — Make it reachable from the UI.** Wire the decision from Step 0a through: `models/configSchema.ts`, `routes/cameras.ts` (`/feature-flags` + validation), `functions/serviceApiCamera.ts` (must actually forward `anpr`), `context/FeatureFlagsContext.tsx` (**3 edits** — interface, defaults, mapping), `container/cameraDirectory/List/Add.tsx`, and `ANPR_DETECTION: "false"` in compose. Mirror the backend changes in `backend-go/internal/routes/cameras.go` and `internal/config/config.go`.
>
> **Step 7 — Dashboard.** `routes/anprDashboard.ts` with `requireAnprFlag`, plus `GET /anpr/dashboard/summary`, `/reads`, and whitelist CRUD. Then `container/anprDashboard/AnprDashboard.tsx` using `axiosJWT` + `Promise.all` + 30 s polling with cleanup. **Take every colour from `src/styles/_tokens.scss`** and use `_classyTable.scss` for the plate-read table — do not copy `JewelryDashboard.tsx`'s hardcoded `#035faa`. Render the `frame_url` thumbnail; jewellery returns it and never shows it. Add the nav entry and route.
>
> **Step 8 — Housekeeping.** Add an `exec_script.sh` for the ANPR image (`ppe_container` and `jewelry_container` both have one; `anpr_service:latest` is built by hand). Reconcile `requirements.txt` — ANPR pins opencv 4.8.1 / ultralytics 8.0.20 / numpy 1.24.4 while the other services are on 4.10 / 8.3.0 / numpy<2. Review whether `deployment/Aksha/labels_anpr.txt` should hold alert-type names (as `labels_jewelry.txt` does) rather than model classes.
>
> **Constraints.**
> - Do not add a Mongoose schema for the `alerts` collection — it is intentionally raw and shared with PPE and jewellery.
> - Do not change the `post_processing` message contract or the `alert_type` discriminator convention.
> - Do not invent endpoints that duplicate existing ones; `grep -rn "anpr\|plate" AkshaV2-UIUX/backend/src/` returning zero hits means everything here is genuinely new.
> - Every new route needs a matching supertest in `backend/tests/routes/`, following `tests/routes/cameras.test.ts`.
> - `Header.tsx` must keep resolving the active tab by `pageUrl`, not array index.

---

## 14. Further reading

| File | Why |
|---|---|
| `FULLSTACK-ONBOARDING-JEWELLARY.md` | The reference implementation — read it before building |
| `FULLSTACK-ONBOARDING-PPE.md` | The closest sibling; also shows what a half-built use case looks like |
| `aksha_backend/anpr/app/anpr.py` | The India-format plate normalisation to reuse |
| `aksha_backend/controller/app/main.py` | Lines 133, 815, 891, 918 — the ANPR wiring |
| `AkshaV2-UIUX/backend/src/routes/jewelryDashboard.ts` | The route pattern |
