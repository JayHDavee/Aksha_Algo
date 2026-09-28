# PPE — Full-Stack Onboarding

**For:** a developer picking up PPE-compliance detection in Aksha v2.1.
**Verified against:** commit `f9ca20a3`. Every path, endpoint, Kafka topic and Mongo field below was read out of the source.

> **The one thing to understand before reading further.**
> PPE is **backend-complete and completely invisible.** `PPE_DETECTION` ships `"true"`, the pipeline runs, and violations are being written into the shared `alerts` collection right now — but there is **no backend route, no page and no nav entry** to read them. Everything a dashboard needs already exists in the database.
>
> Building that dashboard is the single highest-value piece of work in this document, and it is close to a clone of the jewellery one.

---

## 1. Status at a glance

### Already implemented

| Layer | Artefact |
|---|---|
| Detection pipeline | `aksha_backend/ppe_kit_detection_service/` → `dockerhubalgo/ppe_container:latest` |
| Person↔PPE association | `app/ppe_alerts.py` — violation classification + severity |
| Kafka output | topic `ppe_results` |
| Alertification | `alert_identification/ppe_alert_consumer.py` |
| Post-processor | `meta_ppe_<cam>` + shared `alerts` dual-write |
| Cooldown | `postfilter.ppe_status_check()` — Redis, 0.5 min |
| Notification | `notif_filter.send_ppe_notification()` — `Type: "PPE Alert"` |
| Feature flag | `PPE_DETECTION`, shipped **`"true"`** |
| Camera wiring | `Detection_Type: "ppe"` → `deployment_mode: "ppe"` → `<cam>-ppe` |
| UI camera selector | `Add.tsx` Detection Type dropdown shows "PPE" when the flag is on |
| Controller | Docker + Kubernetes, all four operations, `safe_delete_ppe` |

### Needs implementation

| Gap | Where | Impact |
|---|---|---|
| **Backend dashboard route** | no `routes/ppeDashboard.ts` | Nothing can read PPE alerts over HTTP |
| **Frontend page** | no `container/ppeDashboard/` | |
| **Nav entry** | `header/headerData.ts` has 4 entries, none for PPE | |
| **Route** | not in `router/Router.tsx` | |
| **Acknowledge / resolve** | no endpoint (same gap as jewellery) | `status`/`acknowledged_*`/`resolved_at` never written |
| **No `No-Harness` class** | `app/ppe.names` | Harness *absence* is not detectable — documented in `ppe_alerts.py` |
| **Stale compose service** | `ppe_detection` (compose line 237) | Leftover of the pre-refactor architecture — see §11 |
| **Every frame published** | `ppe_reader.py` | One Kafka message *per person per frame*, compliant people included |

---

## 2. End-to-end flow

```
  RTSP camera
       │
       ▼
  <cam>-ppe container                     dockerhubalgo/ppe_container:latest
  aksha_backend/ppe_kit_detection_service/   reads RTSP directly · ONNX · person↔PPE association
       │
       │  Kafka: ppe_results              ONE MESSAGE PER PERSON PER FRAME
       ▼                                  (including compliant people, severity "none")
  ppe_alert_consumer.py                   group alert-service-ppe-group
       │                                  forwards EVERYTHING, adds alert_type
       │  Kafka: post_processing          + alert_type: "ppe"
       ▼
  post_processor/app/main.py              3-way batch dispatch
       ├──▶ Mongo  meta_ppe_<cam>         EVERY frame (compliant or not)
       ├──▶ Mongo  alerts                 VIOLATIONS ONLY · alert_type: "PPE_VIOLATION"
       └──▶ Kafka  notification_service   Type: "PPE Alert"
       │
       ▼
  ✗ MISSING: node_backend route
  ✗ MISSING: frontend page
```

Note the two-tier write: **`meta_ppe_<cam>` gets everything, `alerts` gets violations only.** A compliance-rate view reads the former; an alert feed reads the latter.

---

## 3. Detection pipeline

`aksha_backend/ppe_kit_detection_service/`

| File | Lines | Role |
|---|---|---|
| `app/main.py` | 40 | argparse entrypoint |
| `app/ppe_reader.py` | 284 | `read_ppe_frames()` — RTSP loop, inference, live view, Kafka publish |
| `app/ppe_detection.py` | 140 | model load, inference, `get_labels()` |
| `app/ppe_alerts.py` | 112 | person↔PPE association, violation classification, severity |
| `app/best.onnx` | — | the model |
| `app/ppe.names` | 8 | class list |

**Dependencies** (`requirements.txt`):
```
opencv-python-headless==4.10.0.84
onnxruntime==1.19.2
kafka-python==2.0.2
requests==2.32.3
```

### Entrypoint arguments

```
--camera_name --rtsp_id --rtsp_url --output_width --output_height --fps --prefilter_threshold
```
`--prefilter_threshold` is accepted and **explicitly unused** — there is no SSIM prefilter; every decoded frame is processed.

The docstring records that this service **replaced** an older Kafka-consumer architecture: it now reads RTSP directly rather than consuming `raw_frame`. That matters because the compose service still references the old model (§11).

### Classes — `app/ppe.names`

```
Person  Helmet  No-Helmet  Shoes  No-Shoes  Goggles  No-Goggles  Harness
```

### Severity — `app/ppe_alerts.py`

```python
SEVERITY_MAP = {
    "Helmet": "high",      "No-Helmet": "high",
    "Harness": "critical",     # no "No-Harness" class exists — see module docstring
    "Goggles": "medium",   "No-Goggles": "medium",
    "Shoes": "low",        "No-Shoes": "low",
}
# per person: severity = highest-priority violation present
severity_order = ["critical", "high", "medium", "low"]
```
A fully-compliant person yields `severity: "none"` — and is still published.

> ⚠️ **Modelling gap.** There is no `No-Harness` class, so harness *absence* cannot be detected; only a present harness is. `Harness: critical` therefore fires on presence, not violation. This is documented in the module docstring and is a model-retraining problem, not a code fix.

### Capture loop — `app/ppe_reader.py`

`read_ppe_frames()`:
1. RTSP capture with skip-rate
2. ONNX inference per frame
3. Draw boxes, save annotated JPEG to `<AKSHA_PATH>/<cam>/ppe_output/`
4. Write `live/workday.jpg` + `live/holiday.jpg`, POST both to `http://node_backend:5000/api/monitor/`
5. Publish to Kafka

### `ppe_results` message schema

```python
{
  "cam_name":       str,
  "person_bbox":    [x, y, w, h],
  "worn":           [str],          # e.g. ["Helmet","Shoes"]
  "violated":       [str],          # e.g. ["No-Goggles"]
  "missing":        [str],
  "severity":       str,            # "critical"|"high"|"medium"|"low"|"none"
  "ppe_detections": [ … ],
  "frame":          str,            # base64 JPEG, full frame
  "person_crop":    str | None,     # base64 JPEG
}
```

⚠️ **One message per detected person, per frame — including compliant people.** This is a continuous compliance stream, not a violation feed. Budget Kafka and Mongo accordingly, and filter on `severity != "none"` when you want violations.

---

## 4. Alertification

`aksha_backend/alert_identification/ppe_alert_consumer.py` (136 lines)

- Standalone process, deliberately **not** merged into `main.py`'s loop — the docstring explains this avoids aiokafka coordinator/rebalance failures
- Consumes `ppe_results`, `group_id="alert-service-ppe-group"`, `max_poll_records=1`
- **Forwards every message regardless of severity** — it is not a filter
- Produces to `post_processing`, keyed by `cam_name`, adding `"alert_type": "ppe"` and passing all other fields through unchanged

**Dependencies:** `pymongo==4.10.1`, `shapely==2.0.6`, `redis[hiredis]==3.0.0`, `aiokafka`

---

## 5. Post-processor

`aksha_backend/post_processor/app/main.py`

| Addition | ~Line |
|---|---|
| `PPEProcessingResult` dataclass | 174 |
| `process_ppe_detection()` | 1261 |
| `_handle_ppe_result()` | 1716 |
| `_flush_ppe_meta_buffer()` | 726 |
| Batch split — `alert_type == "ppe"` | 2106 |
| PPE bypasses the frame_id/staleness gate entirely | 2052 |

```python
ppe_batch = [sr for sr in to_process if sr.alert_type == "ppe"]
```

**Two writes, different scopes:**
- **every** message → `meta_ppe_<camera>`, batched via `_flush_ppe_meta_buffer()`
- **violations only** → shared `alerts` collection

Cooldown: `postfilter.ppe_status_check()` (`postfilter.py:378`) — Redis-backed, key `ppe_alert`, default 0.5 min. Note this is a **single shared key**, unlike jewellery's per-rule `jewelry_alert_<rule>`.

Notification: `notif_filter.send_ppe_notification()` (`notif_filter.py:451`) → `Type: "PPE Alert"`.

**No `live_update` publish** — the PPE container posts its own live view directly to `/api/monitor/`.

---

## 6. Database / data flow

### `meta_ppe_<camera>` — every frame, compliant or not

Written by `_flush_ppe_meta_buffer()`. Use this collection for compliance *rates*; it is the denominator.

### `alerts` — violations only, the shared dashboard contract

```js
{ cam_name:         String,
  alert_type:       "PPE_VIOLATION",
  severity:         String,                 // critical|high|medium|low
  metadata:         { worn_ppe, violated_ppe, missing_ppe, person_bbox, ppe_detections },
  frame_path:       String,
  person_crop_path: null,                   // ALWAYS null — see below
  timestamp:        Date,
  status:           "NEW",
  acknowledged_by:  null,
  acknowledged_at:  null,
  resolved_at:      null }
```

⚠️ **`person_crop_path` is always `None`** even though the pipeline publishes a `person_crop` base64 image. The crop is transmitted and then discarded. If a dashboard wants per-person thumbnails, that write has to be added in `_handle_ppe_result()`.

**This is byte-identical in shape to jewellery's `JEWELRY_<RULE>` documents** — same collection, same `status: "NEW"` convention. That is precisely why the dashboard is a clone.

Naming traps: lowercase `alerts` = fired alerts (raw, **no Mongoose schema**); capital-A `Alerts` = user-defined alert rules (`models/myAlertSchema.ts`). Different collections.

---

## 7. APIs

### Existing — not PPE-specific but PPE-relevant

**Feature flags** — `routes/cameras.ts:54`
```
GET /api/feature-flags
```
```json
{ "success": true, "PPE_DETECTION": true, "JEWELRY_DETECTION": false }
```
Called by `context/FeatureFlagsContext.tsx` on mount.

**Camera create** — persists `Detection_Type`, 403s if the flag is off
```
POST /api/camera/create
```
```json
{ "Camera_Name": "FLOOR_2", "Rtsp_Link": "rtsp://…", "rtsp_id": 7,
  "Detection_Type": "ppe", "FPS": 3, "Priority": "High" }
```
**403** `{"success":false,"message":"PPE detection is not enabled"}`

**Camera update** — same gate, restarts the camera
```
PUT /api/camera/update/:id
```

**Object labels**
```
GET /api/object-labels?use_case=ppe      → reads ${AKSHA_PATH}/labels_ppe.txt
```

### Missing — the routes to build

All three belong in a new `AkshaV2-UIUX/backend/src/routes/ppeDashboard.ts`, modelled on `jewelryDashboard.ts`.

**1. Summary**
```
GET /api/ppe/dashboard/summary
Gate: requirePpeFlag → 403 when process.env.PPE_DETECTION !== "true"
Handled by: routes/ppeDashboard.ts    Called by: PpeDashboard.tsx
```
```json
{ "success": true,
  "summary": { "active_violations": 8, "violations_today": 31, "critical_active": 2,
               "by_severity": { "critical": 2, "high": 4, "medium": 2, "low": 0 } } }
```
Query: `{ alert_type: "PPE_VIOLATION", status: "NEW" }`.

**2. Violations feed**
```
GET /api/ppe/dashboard/alerts?limit=20&camera_name=FLOOR_2
limit default 25, capped 100 · camera_name optional → cam_name
```
```json
{ "success": true,
  "alerts": [
    { "id": "6712ab…", "camera_name": "FLOOR_2",
      "violated": ["No-Helmet"], "worn": ["Shoes"], "missing": [],
      "severity": "high",
      "timestamp": "2026-09-23T10:14:22.000Z", "status": "NEW",
      "frame_url": "http://host:5000/FLOOR_2/alerts/2026-09-23/….jpg" } ] }
```
`violated`/`worn`/`missing` come from `metadata.violated_ppe` etc.

**3. Violations by type** — PPE's useful axis
```
GET /api/ppe/dashboard/violations-by-type
```
```json
{ "success": true,
  "by_type": [ { "type": "No-Helmet", "count": 18 },
               { "type": "No-Goggles", "count": 9 },
               { "type": "No-Shoes", "count": 4 } ] }
```
`$unwind` + `$group` on `metadata.violated_ppe`.

> Do **not** copy jewellery's `/footfall` endpoint. It is misnamed there (it returns hourly alert volume) and has no PPE meaning. If you want a time series, name it `alert-volume`.

---

## 8. Frontend

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

⚠️ `JewelryDashboard.tsx` hardcodes `#035faa` and a local `SEVERITY_COLOR` map. **Do not copy that part.** Use `var(--color-primary)` and semantic tokens; if you need severity hues, add `--color-severity-critical|high|medium|low` to `_tokens.scss` so all three dashboards share one definition.

### Existing PPE frontend code

Exactly one thing exists — the camera form selector at `container/cameraDirectory/List/Add.tsx:650`:
```tsx
const { PPE_DETECTION, JEWELRY_DETECTION } = useFeatureFlags();
…
{PPE_DETECTION && <option value="ppe">{t("PPE")}</option>}
```
PR #31 introduced this selector; before it, **PPE could not be chosen in the UI at all** despite the backend supporting it.

### Files to create

```
src/container/ppeDashboard/
  PpeDashboard.tsx        page — state, fetching, flag gate
  ppeDashboard.scss       styles, using tokens
```

### Files to modify

| File | Change |
|---|---|
| `header/headerData.ts` | nav entry `{ name:"PPE Dashboard", pageUrl:"/ppe-dashboard", featureFlag:"PPE_DETECTION" }` |
| `router/Router.tsx` | `<Route path="/ppe-dashboard" element={<PpeDashboard />} />` |
| `backend/src/appRoutes.ts` | `import ppeDashboardRoutes …; appRoutes.use("/api", ppeDashboardRoutes, apiTimeOut);` |

`context/FeatureFlagsContext.tsx` needs **no change** — `PPE_DETECTION` is already in its interface, defaults and mapping.

### Frontend → backend integration

Follow the jewellery convention (`axiosJWT`, not `useApi`):

```ts
import axiosJWT from "../../context/axiosAuthIntercept";
import { useFeatureFlags } from "../../context/FeatureFlagsContext";

const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

const { PPE_DETECTION } = useFeatureFlags();
if (!PPE_DETECTION) return <p>PPE detection is not enabled for this deployment.</p>;

useEffect(() => {
  const load = async () => {
    const [s, a, t] = await Promise.all([
      axiosJWT.get(`${VITE_base_url}/api/ppe/dashboard/summary`),
      axiosJWT.get(`${VITE_base_url}/api/ppe/dashboard/alerts?limit=20`),
      axiosJWT.get(`${VITE_base_url}/api/ppe/dashboard/violations-by-type`),
    ]);
    …
  };
  load();
  const id = setInterval(load, 30000);
  return () => clearInterval(id);
}, [PPE_DETECTION]);
```

**Two conventions exist in this codebase.** Older screens use the `useApi()` hook; the newest dashboard uses `axiosJWT` directly. Both carry the JWT interceptor. Never call bare `axios` from a component.

⚠️ `Header.tsx` resolves the active tab **by `pageUrl`**, not by array index — that fix landed with the jewellery flag and is what lets a flag-filtered nav array be shorter than `pages`. Do not regress it.

### Suggested dashboard layout

4 KPI tiles (Active Violations / Violations Today / Critical Active / By Severity) → Violations-by-type `<Bar>` chart → Recent Violations feed with `frame_url` thumbnails and the `violated` PPE items as chips.

---

## 9. Controller

`aksha_backend/controller/app/main.py`

- `safe_delete_ppe(client, name)` — line 528, removes `f"{name}-ppe"` only
- `create_ppe_deployment_object()` — line 625, `name=f"{item.camera_name}-ppe"`, `image="dockerhubalgo/ppe_container:latest"`
- Triggered when `deployment_mode == "ppe"` (line 880), preceded by `safe_delete_ppe`
- Restart sweep suffixes: `["-rtsp","-ppe","-jewelry","-anomaly","-face","-anpr"]`

Backend mapping: `Detection_Type: "ppe"` → `deployment_mode: "ppe"` via `DETECTION_TYPE_TO_DEPLOYMENT_MODE` in `cameras.ts`.

Kubernetes equivalents exist in `controller_kubernetes/app/main.py`.

---

## 10. Configuration

```yaml
# deployment/docker-compose.yml — node_backend.environment
PPE_DETECTION: "true"        # shipped ON
JEWELRY_DETECTION: "false"
```

```yaml
# line 299 — correct and current
ppe_alert_consumer:
  image: dockerhubalgo/alert_identification:03072026-2
  command: ["python", "ppe_alert_consumer.py"]
  environment: { KAFKA_BOOTSTRAP_SERVERS: broker:9092, AKSHA_PATH: /Aksha }
```

`deployment/Aksha/labels_ppe.txt` — served by `GET /api/object-labels?use_case=ppe`.

---

## 11. ⚠️ The stale compose service

```yaml
# line 237 — DO NOT treat this as the live PPE detector
ppe_detection:
  image: dockerhubalgo/ppe_detection:19062026
  deploy: { replicas: 2 }
  environment: { AKSHA_PATH, KAFKA_BOOTSTRAP_SERVERS: broker:9092, ENABLE_GPU: false, … }
```

This is a leftover of the **pre-refactor always-on Kafka-consumer architecture**. The current `app/main.py` *requires* `--camera_name`/`--rtsp_url` and is launched per-camera by the controller as `dockerhubalgo/ppe_container:latest` — a different image name and a different invocation model.

Corroborating evidence: there is **no** `jewelry_detection` compose service, because jewellery is per-camera only. PPE's per-camera model is identical, which is what makes `ppe_detection` vestigial.

Treat removing it as cleanup, but confirm with whoever runs the deployments first.

---

## 12. Testing

**Backend** — Jest + supertest, `AkshaV2-UIUX/backend/tests/routes/ppeDashboard.test.ts`:
```ts
import request from "supertest";
import express from "express";
import ppeDashboard from "../../src/routes/ppeDashboard";

const app = express();
app.use(express.json());
app.use("/api", ppeDashboard);

describe("PPE dashboard", () => {
  it("403s when the flag is off", async () => {
    delete process.env.PPE_DETECTION;
    const res = await request(app).get("/api/ppe/dashboard/summary");
    expect(res.status).toBe(403);
  });
});
```
Run: `cd AkshaV2-UIUX/backend && npm test`
Existing examples to copy: `tests/routes/cameras.test.ts`, `tests/routes/alerts.test.ts`.

**Go** — mirror in `backend-go/internal/routes/`, `go test ./...`
**Frontend** — `cd AkshaV2-UIUX/frontend && npm test`

**Manual end-to-end** — PPE is already running, so you can verify the data before writing any code:
1. `mongosh` → `db.alerts.find({alert_type:"PPE_VIOLATION"}).sort({timestamp:-1}).limit(5)` — **this should already return rows**
2. `db.getCollectionNames().filter(n => n.startsWith("meta_ppe_"))`
3. `docker logs --tail 50 ppe_alert_consumer`
4. Create a camera with Detection Type = PPE → confirm `<cam>-ppe` in `docker ps`
5. `docker logs --tail 100 <cam>-ppe`
6. After building the route: `curl localhost:5000/api/ppe/dashboard/summary`
7. Flag-off check: set `PPE_DETECTION: "false"`, restart `node_backend`, expect 403 and a hidden nav entry

---

## 13. Claude Code implementation prompt

> **Context.** Aksha v2.1, commit `f9ca20a3`. PPE detection is backend-complete and has no read path. `aksha_backend/ppe_kit_detection_service/` reads RTSP and publishes to Kafka `ppe_results` (one message per person per frame, including compliant people with `severity: "none"`). `alert_identification/ppe_alert_consumer.py` forwards everything to `post_processing` with `alert_type: "ppe"`. `post_processor/app/main.py` writes every frame to `meta_ppe_<cam>` and dual-writes **violations only** into the shared `alerts` collection as `alert_type: "PPE_VIOLATION"`, with `metadata.violated_ppe` / `worn_ppe` / `missing_ppe`. `PPE_DETECTION` is already `"true"` in compose, already returned by `GET /api/feature-flags`, and already present in `FeatureFlagsContext`. What is missing is only the read path: no backend route, no page, no nav entry.
>
> The jewellery use case is the reference: `backend/src/routes/jewelryDashboard.ts` and `frontend/src/container/jewelryDashboard/`.
>
> **Task.** Build the PPE dashboard.
>
> **1. Backend** — create `AkshaV2-UIUX/backend/src/routes/ppeDashboard.ts` modelled on `jewelryDashboard.ts`:
> - local `requirePpeFlag` middleware → 403 `{success:false, message:"PPE detection is not enabled"}` when `process.env.PPE_DETECTION !== "true"`
> - `alertsCollection()` via `mongoose.connection.db.collection("alerts")` — **do not create a Mongoose schema**, this collection is intentionally raw and shared with jewellery
> - `frameUrl()` stripping `process.env.AKSHA_PATH`
> - `GET /ppe/dashboard/summary` → active violations, violations today, critical active, by-severity breakdown, all filtered `alert_type: "PPE_VIOLATION"`
> - `GET /ppe/dashboard/alerts` → `limit` (default 25, capped 100), optional `camera_name` → `cam_name`, sorted `timestamp: -1`, surfacing `metadata.violated_ppe` / `worn_ppe` / `missing_ppe` and `frame_url`
> - `GET /ppe/dashboard/violations-by-type` → `$unwind` + `$group` on `metadata.violated_ppe`. **Do not copy jewellery's `/footfall` endpoint** — it is misnamed there and meaningless for PPE.
> - register in `appRoutes.ts` beside the jewellery line
>
> **2. Frontend** — create `src/container/ppeDashboard/PpeDashboard.tsx` + `ppeDashboard.scss`:
> - `useFeatureFlags().PPE_DETECTION`, early return when false
> - `axiosJWT` + `Promise.all` + `setInterval(load, 30000)` with cleanup — the jewellery convention, not `useApi`
> - **Take every colour from `src/styles/_tokens.scss`** (`var(--color-primary)`, `var(--color-danger)`, …). `JewelryDashboard.tsx` hardcodes `#035faa` and a local `SEVERITY_COLOR` map — do not copy that. If severity hues are needed, add `--color-severity-critical|high|medium|low` to `_tokens.scss` so all three dashboards share one definition.
> - **Render the `frame_url` thumbnail.** Jewellery fetches it and never shows it; don't repeat that.
> - Layout: 4 KPI tiles → violations-by-type bar chart → recent violations feed with violated-PPE chips
>
> **3. Navigation** — add the entry to `header/headerData.ts` with `featureFlag: "PPE_DETECTION"`, and the route to `router/Router.tsx`. Verify `Header.tsx` still resolves the active tab by `pageUrl` rather than array index; index-based lookup breaks when the flag-filtered nav array is shorter than `pages`.
>
> **4. Tests** — `backend/tests/routes/ppeDashboard.test.ts` with supertest, covering flag-off 403, empty result, and a populated summary. Follow `tests/routes/cameras.test.ts`.
>
> **Constraints.**
> - Do not touch the pipeline, `ppe_alert_consumer.py`, or the post-processor — they work and are in production.
> - Do not change the `ppe_results` or `post_processing` message shapes.
> - Mirror any new route in `backend-go/internal/routes/` with identical JSON, or state explicitly that it is Node-only.
> - Do not remove the stale `ppe_detection` compose service (line 237) as part of this work — flag it separately; it needs a deployment owner's sign-off.
>
> **Worth surfacing while you are in here** (report, do not necessarily fix):
> - `person_crop_path` is always written as `None` in `_handle_ppe_result()` even though the pipeline publishes a `person_crop` base64 image — per-person thumbnails are one line away.
> - There is no `No-Harness` class in `app/ppe.names`, so harness absence is undetectable and `Harness: critical` fires on presence.
> - `container/cameraDirectory/List/List.tsx` (~line 340) PUTs `/api/camera/update/:id` without `Detection_Type`, so toggling an email-alert switch on a PPE camera silently converts it to standard and restarts it.

---

## 14. Further reading

| File | Why |
|---|---|
| `FULLSTACK-ONBOARDING-JEWELLARY.md` | The reference implementation you are cloning |
| `FULLSTACK-ONBOARDING-ANPR.md` | Sibling use case — prototype only |
| `AkshaV2-UIUX/backend/src/routes/jewelryDashboard.ts` | The route to copy |
| `aksha_backend/ppe_kit_detection_service/app/ppe_alerts.py` | Severity and association logic |
| `aksha_backend/post_processor/app/main.py` | `_handle_ppe_result` at ~1716 |
