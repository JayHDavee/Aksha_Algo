"""
alert_identification — Kafka-driven alert evaluation service.

Architecture:

  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  KafkaAlertService  (asyncio + ThreadPoolExecutor)                            │
  │                                                                               │
  │  Kafka consumer: object_detection_results                                     │
  │    ↓  parse headers (frame_id, camera_name)                                  │
  │    ↓  get_camera_config()                                                     │
  │         └─ Redis cache  (TTL 5 min)  ──→ hit: return cached list             │
  │         └─ MongoDB Alerts collection ──→ miss: fetch, serialize, cache        │
  │    ↓  process_detection()                                                     │
  │         ├─ no objects in frame  → evaluate no-object alert rules             │
  │         └─ objects detected     → _check_alert_conditions()                  │
  │              └─ maf.apply_filter() [thread pool — CPU-bound sync]            │
  │                   ├─ day / time gate  (incl. overnight-alert handling)       │
  │                   ├─ polygon intersection  (Shapely Point-in-Polygon)        │
  │                   └─ crowd threshold  (count persons ≥ threshold)            │
  │    ↓  publish AlertResult to post_processing topic                            │
  │         └─ partition = MD5(frame_id) % N  (spread load across partitions)   │
  └──────────────────────────────────────────────────────────────────────────────┘

  External dependencies:
    Redis       — camera-config cache  (avoids per-frame MongoDB round-trips)
    MongoDB     — Alerts collection    (alert configs per camera)
    Kafka       — consumer: object_detection_results
                  producer: post_processing
"""

import json
import asyncio
import hashlib
from typing import Dict, Any, Optional
import datetime as dt
from collections import defaultdict
import redis
import pymongo
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from dataclasses import dataclass, asdict
import logging
from redis.exceptions import RedisError
import backoff
from concurrent.futures import ThreadPoolExecutor
import my_alert_filters as maf
import os

# -------------------- STARTUP: ENV VARS --------------------

def load_kafka_config():
    """Resolve the Kafka bootstrap server from env, falling back to docker/local defaults."""
    # Stage: resolve Kafka bootstrap server from env or apply container/local fallback
    print(f"KAFKA_BOOTSTRAP_SERVERS env: {os.environ.get('KAFKA_BOOTSTRAP_SERVERS')}", flush=True)
    print(f"Running in Docker: {os.path.exists('/.dockerenv')}", flush=True)
    KAFKA_SERVER = os.environ.get("KAFKA_BOOTSTRAP_SERVERS")
    if not KAFKA_SERVER:
        print("KAFKA_BOOTSTRAP_SERVERS not set in environment, using fallback...", flush=True)
        if os.path.exists("/.dockerenv"):
            KAFKA_SERVER = "broker:9092"
        else:
            KAFKA_SERVER = "localhost:9092"
    else:
        print(f"Using KAFKA_SERVER from environment: {KAFKA_SERVER}", flush=True)
    return KAFKA_SERVER


KAFKA_SERVER = load_kafka_config()
REDIS_HOST = os.environ.get('REDIS_HOST', 'localhost')
REDIS_PORT = int(os.environ.get('REDIS_PORT_NUMBER', 6379))
MONGODB_URI = os.environ.get('MONGODB_URI', 'mongodb://localhost:27017')

# FRAME_PATH_ENABLE: when set, payload carries a file path instead of raw JPEG bytes
FRAME_PATH_ENABLE = os.environ.get('frame_path', False)

# -------------------- DATA MODEL --------------------

@dataclass
class AlertResult:
    """
    Structured output from process_detection() — serialised into the Kafka output payload.

    Fields:
      camera_name               — identifies the source camera
      alert_results             — list of triggered alert names (empty = no alert)
      no_object_status          — True when a no-object alert fired (expected object absent)
      detection_results         — raw OD detections forwarded downstream unchanged
      alert_description         — human-readable description per triggered alert
      alert_notification_validity — email notification flag per triggered alert
      noobj_alert_result_config — full config for triggered no-object alerts
      alert_result_config       — full config for triggered object-present alerts
    """
    camera_name: str
    alert_results: str
    no_object_status: bool
    detection_results: list
    alert_description: list
    alert_notification_validity: list
    noobj_alert_result_config: list
    alert_result_config: list

    def to_dict(self):
        """Convert this dataclass to a plain dict for JSON serialisation."""
        return asdict(self)

# -------------------- KAFKA ALERT SERVICE --------------------

class KafkaAlertService:
    """
    Async Kafka consumer/producer that evaluates OD detections against alert rules.

    One instance per process. Consumes from *consumer_topic*, queries alert configs
    from Redis (cache) or MongoDB (source of truth), runs my_alert_filters.apply_filter
    in a thread pool to avoid blocking the event loop, then publishes results to
    *producer_topic*.
    """

    def __init__(
        self,
        kafka_bootstrap_servers: str,
        redis_host: str,
        redis_port: int,
        mongo_uri: str,
        consumer_topic: str,
        producer_topic: str,
        logger,
        consumer_group: str = "alert-service-group"
    ):
        """Wire up Kafka topology, Redis cache client, MongoDB client, and thread pool."""
        self.logger = logger

        # Stage: store Kafka topology config
        self.bootstrap_servers = kafka_bootstrap_servers
        self.consumer_topic = consumer_topic
        self.producer_topic = producer_topic
        self.consumer_group = consumer_group
        self.logger.info(
            f"KafkaAlertService init | consumer_topic={consumer_topic} | producer_topic={producer_topic} "
            f"| group={consumer_group} | kafka={kafka_bootstrap_servers}"
        )

        # Stage: connect to Redis for camera-config caching (5-min TTL per key)
        self.redis_client = redis.Redis(
            host=redis_host,
            port=redis_port,
            decode_responses=True,
            socket_timeout=5,
            retry_on_timeout=True
        )
        self.logger.info(f"Redis client created | host={redis_host} | port={redis_port}")

        # Stage: connect to MongoDB for persistent alert config storage
        self.mongo_client = pymongo.MongoClient(mongo_uri)
        self.db = self.mongo_client['Aksha']
        self.collection = self.db['Alerts']
        self.logger.info(f"MongoDB client created | db=Aksha | collection=Alerts | uri={mongo_uri}")

        # Stage: thread pool for CPU-bound / blocking sync operations (Redis, Mongo, alert filter)
        self.thread_pool = ThreadPoolExecutor(max_workers=10)
        self.logger.info("ThreadPoolExecutor created | max_workers=10")

        self.consumer = None
        self.producer = None
        self._camera_partition_map: dict = {}
        self._num_partitions: int = 0

    def _serialize_for_json(self, value):
        """Convert datetime/date values to ISO strings so they are JSON-serializable."""
        if isinstance(value, (dt.datetime, dt.date)):
            return value.isoformat()
        return value

    # -------------------- START / STOP --------------------

    async def start(self):
        """Start the Kafka consumer and producer, then enter the message loop."""
        self.logger.info("Starting Kafka consumer and producer")
        try:
            # Stage: create async Kafka consumer — manual commit, batch up to 50 records
            self.consumer = AIOKafkaConsumer(
                self.consumer_topic,
                bootstrap_servers=self.bootstrap_servers,
                group_id=self.consumer_group,
                value_deserializer=lambda m: json.loads(m.decode('utf-8')),
                enable_auto_commit=False,
                max_poll_records=1,
                fetch_max_bytes=52428800,
                max_poll_interval_ms=600000,
                session_timeout_ms=60000,
                heartbeat_interval_ms=20000,
            )

            # Stage: create async Kafka producer
            self.producer = AIOKafkaProducer(
                bootstrap_servers=self.bootstrap_servers,
                value_serializer=lambda m: json.dumps(m).encode('utf-8'),
            )

            await self.consumer.start()
            self.logger.info(f"Kafka consumer started | topic={self.consumer_topic} | group={self.consumer_group}")

            await self.producer.start()
            self.logger.info(f"Kafka producer started | topic={self.producer_topic}")

            # Fetch actual partition count from Kafka — this is the ground truth.
            # Avoids hardcoding and automatically matches whatever the topic is configured with.
            try:
                partitions = await self.producer.partitions_for(self.producer_topic)
                self._num_partitions = len(partitions)
                self.logger.info(f"Topic partition count | topic={self.producer_topic} | partitions={self._num_partitions}")
            except Exception as e:
                self.logger.warning(f"Could not fetch partition count, defaulting to 10: {e}")
                self._num_partitions = 10

            # Stage: build deterministic camera→partition map from MongoDB config at startup.
            # Sorted alphabetically so all alert_identification instances agree on the same map.
            try:
                loop = asyncio.get_event_loop()
                all_cameras = await loop.run_in_executor(
                    self.thread_pool,
                    lambda: sorted(self.db['config'].distinct("Camera_Name"))
                )
                self._camera_partition_map = {cam: idx % self._num_partitions for idx, cam in enumerate(all_cameras)}
                self.logger.info(f"Camera partition map built | count={len(all_cameras)} | map={self._camera_partition_map}")
            except Exception as e:
                self.logger.warning(f"Failed to build camera partition map, falling back to key routing: {e}")

            await self.process_messages()

        except Exception as e:
            self.logger.error(f"Failed to start Kafka service: {e}")
            raise

    async def stop(self):
        """Gracefully stop consumer, producer, and thread pool."""
        self.logger.info("Stopping Kafka alert service")
        try:
            if self.consumer:
                await self.consumer.stop()
                self.logger.info("Kafka consumer stopped")
            if self.producer:
                await self.producer.stop()
                self.logger.info("Kafka producer stopped")
            self.thread_pool.shutdown()
            self.logger.info("Thread pool shut down")
        except Exception as e:
            self.logger.error(f"Error stopping Kafka service: {e}")

    # -------------------- CAMERA CONFIG (REDIS CACHE + MONGO) --------------------

    @backoff.on_exception(
        backoff.expo,
        (redis.exceptions.ConnectionError, redis.exceptions.TimeoutError),
        max_tries=5
    )
    async def get_camera_config(self, camera_name: str) -> Optional[list]:
        """Return alert configs for the camera — Redis first, MongoDB fallback."""
        cache_key = f"camera_config:{camera_name}"

        try:
            # Stage: try Redis cache first — avoids a MongoDB round-trip on every frame
            cached_data = await asyncio.get_event_loop().run_in_executor(
                self.thread_pool,
                self.redis_client.get,
                cache_key
            )

            if cached_data:
                self.logger.info(f"Cache HIT | camera={camera_name} | key={cache_key}")
                return json.loads(cached_data)

            # Stage: cache miss — fetch all alert configs for this camera from MongoDB
            self.logger.info(f"Cache MISS | camera={camera_name} | querying MongoDB")
            processed_configs = []
            docs = await asyncio.get_event_loop().run_in_executor(
                self.thread_pool,
                lambda: list(self.collection.find({"Camera_Name": camera_name}))
            )
            self.logger.info(f"MongoDB returned {len(docs)} config docs | camera={camera_name}")

            for doc in docs:
                doc_copy = doc.copy()
                doc_copy.pop('_id', None)
                for key, value in doc_copy.items():
                    doc_copy[key] = self._serialize_for_json(value)
                doc_copy = self._check_overnight_alert(doc_copy)
                processed_configs.append(doc_copy)

            if processed_configs:
                # Stage: populate Redis cache so subsequent frames skip the DB query
                await self._update_cache(camera_name, processed_configs)
                self.logger.info(f"Config cached | camera={camera_name} | alert_count={len(processed_configs)}")
                return processed_configs
            else:
                self.logger.info(f"No alert configuration found in MongoDB | camera={camera_name}")
                return None

        except Exception as e:
            self.logger.error(f"Error getting config for camera {camera_name}: {e}")
            return None

    def _check_overnight_alert(self, alert: dict):
        """Extend Days_Active for alerts that span midnight."""
        if (dt.datetime.strptime(alert["Start_Time"], '%H:%M').time() >
                dt.datetime.strptime(alert["End_Time"], '%H:%M').time()):
            day_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
            days_to_add = []
            first_day = []
            for i in alert["Days_Active"]:
                current_day_index = day_names.index(i)
                prev_day_name = day_names[(current_day_index - 1) % 7]
                next_day_name = day_names[(current_day_index + 1) % 7]
                if prev_day_name not in alert["Days_Active"]:
                    first_day.append(i)
                if next_day_name not in alert["Days_Active"]:
                    days_to_add.append(next_day_name)
            alert["Days_Active"].extend(days_to_add)
            alert["last_overnight_day"] = days_to_add
            alert["first_day"] = first_day
        return alert

    async def _update_cache(self, camera_name: str, config: list):
        """Write camera config to Redis with a 5-minute TTL."""
        cache_key = f"camera_config:{camera_name}"
        try:
            await asyncio.get_event_loop().run_in_executor(
                self.thread_pool,
                self.redis_client.setex,
                cache_key,
                300,  # 5-minute TTL — config changes are picked up within 5 min
                json.dumps(config)
            )
            self.logger.info(f"Redis cache updated | camera={camera_name} | key={cache_key} | ttl=300s")
        except Exception as e:
            self.logger.error(f"Failed to update cache for camera {camera_name}: {e}")

    async def pre_warm_cache(self):
        """Load all camera configs into Redis before the first message arrives."""
        self.logger.info("Pre-warming Redis cache with all camera configs")
        try:
            configs = await asyncio.get_event_loop().run_in_executor(
                self.thread_pool,
                lambda: list(self.collection.find({}))
            )
            self.logger.info(f"Pre-warm: {len(configs)} camera configs found in MongoDB")
            for config in configs:
                camera_name = config['camera_name']
                config.pop('_id', None)
                await self._update_cache(camera_name, config)
            self.logger.info("Pre-warm complete — all camera configs cached in Redis")
        except Exception as e:
            self.logger.error(f"Failed to pre-warm cache: {e}")

    # -------------------- DETECTION → ALERT LOGIC --------------------

    async def process_detection(self, detection: list, camera_name: str) -> Optional[AlertResult]:
        """Map detection results to alert outcomes using the camera's alert config."""
        self.logger.info(f"Processing detection | camera={camera_name} | objects_in_frame={len(detection) if detection else 0}")
        try:
            camera_config = await self.get_camera_config(camera_name)
            self.logger.info(f"Alert config retrieved | camera={camera_name} | alert_count={len(camera_config) if camera_config else 0}")

            alert_results = []
            alert_result_config = []
            alert_description = []
            alert_notification_validity = []
            noobj_alert_result_config = []
            no_object_status = False

            if camera_config:
                if not detection:
                    # Stage: no objects in frame — check for "no-object" alert rules
                    self.logger.info(f"No objects detected — evaluating no-object alert rules | camera={camera_name}")
                    no_obj_configs = [doc for doc in camera_config if str(doc.get("No_Object_Status", "")).lower() == "false"]
                    filtered_objects = []
                    if no_obj_configs:
                        no_object_status = False
                        for i in no_obj_configs:
                            if (dt.datetime.strptime(i["Start_Time"], '%H:%M').time()
                                    < dt.datetime.now().time()
                                    < dt.datetime.strptime(i["End_Time"], '%H:%M').time()):
                                alert_results.append(i["Alert_Name"])
                                alert_description.append(i['Alert_Description'])
                                alert_notification_validity.append(i['Email_Activation'])
                                alert_filter_result = {
                                    "Alert_Name": i["Alert_Name"],
                                    "Display_Activation": i["Display_Activation"],
                                    "Workday": i["Workday"],
                                    "Holiday": i["Holiday"],
                                    "Filtered_Objects": filtered_objects,
                                    "No_Object_Status": i["No_Object_Status"],
                                    "Area_of_Interest": i["Area_of_Interest"],
                                    "Email_Activation": i["Email_Activation"],
                                    "Alert_Description": i["Alert_Description"]
                                }
                                noobj_alert_result_config.append(alert_filter_result)
                                no_object_status = True
                        self.logger.info(
                            f"No-object alert evaluation done | camera={camera_name} "
                            f"| triggered={alert_results}"
                        )
                else:
                    # Stage: objects detected — run full alert filter logic
                    self.logger.info(f"Objects detected — running alert filter | camera={camera_name} | objects={len(detection)}")
                    alert_results, alert_result_config, no_object_status, \
                        alert_description, alert_notification_validity, \
                        noobj_alert_result_config = await self._check_alert_conditions(detection, camera_config)
            else:
                self.logger.warning(f"No alert config found — skipping alert evaluation | camera={camera_name}")

            self.logger.info(
                f"Detection processing complete | camera={camera_name} "
                f"| alerts_triggered={alert_results} | no_object_status={no_object_status}"
            )
            return AlertResult(
                camera_name=camera_name,
                no_object_status=no_object_status,
                noobj_alert_result_config=noobj_alert_result_config,
                alert_description=alert_description,
                alert_notification_validity=alert_notification_validity,
                alert_results=alert_results,
                detection_results=detection,
                alert_result_config=alert_result_config
            )

        except Exception as e:
            self.logger.error(f"Error processing detection for camera={camera_name}: {e}")
            return None

    async def _check_alert_conditions(self, detection: Dict, camera_config: Dict) -> Dict:
        """Run my_alert_filters.apply_filter in a thread and return structured alert results."""
        self.logger.info(f"Running alert filter | detection_count={len(detection)}")
        try:
            crowd_threshold = int(os.getenv("CROWD_THRESHOLD"))
            noobj_alert_result_config = []

            # Stage: apply_filter is CPU-bound sync work — offload to thread pool to free the event loop
            t0 = dt.datetime.now()
            alert_results, alert_result_config, no_object_status = await asyncio.get_event_loop().run_in_executor(
                self.thread_pool,
                maf.apply_filter,
                camera_config, detection, crowd_threshold, self.logger
            )
            elapsed_ms = (dt.datetime.now() - t0).total_seconds() * 1000

            alert_description = []
            alert_notification_validity = []
            if len(alert_result_config) > 0:
                for i in alert_result_config:
                    alert_description.append(i['Alert_Description'])
                    alert_notification_validity.append(i['Email_Activation'])

            self.logger.info(
                f"Alert filter complete | elapsed_ms={elapsed_ms:.1f} "
                f"| alert_results={alert_results} | no_object_status={no_object_status} "
                f"| matched_configs={len(alert_result_config)}"
            )
            return alert_results, alert_result_config, no_object_status, alert_description, alert_notification_validity, noobj_alert_result_config

        except Exception as e:
            print(f"error in _check_alert_conditions {e}", flush=True)
            self.logger.error(f"Error in _check_alert_conditions: {e}")
            return None

    # -------------------- MAIN CONSUMER LOOP --------------------

    async def process_messages(self):
        """Consume object_detection_results, evaluate alerts, publish to post_processing."""
        COMMIT_INTERVAL = 10
        commit_count = 0
        self.logger.info(
            f"Entering message processing loop | pipeline: {self.consumer_topic} → alert_identification → {self.producer_topic} "
            f"| commit_every={COMMIT_INTERVAL}"
        )
        try:
            async for message in self.consumer:
                try:
                    # Stage: frame received from Kafka — log partition/offset for traceability
                    self.logger.info(
                        f"[FRAME RECEIVED] topic={message.topic} | partition={message.partition} "
                        f"| offset={message.offset}"
                    )

                    # Stage: parse Kafka message headers (frame_id, camera_name)
                    headers = {k: v.decode('utf-8') if v else None for k, v in message.headers}
                    camera_name = headers.get('camera_name')
                    frame_id = headers.get('frame_id')
                    self.logger.info(f"Headers parsed | frame_id={frame_id} | camera={camera_name}")

                    # Stage: extract detection results and frame reference from payload
                    payload = message.value
                    frame_bytes = payload.get("frame_bytes")
                    frame_path = None
                    if FRAME_PATH_ENABLE:
                        frame_path = payload.get("frame_path")
                    detection = payload.get("object_detection_results")
                    self.logger.info(
                        f"Payload parsed | frame_id={frame_id} | camera={camera_name} "
                        f"| detection_count={len(detection) if detection else 0} "
                        f"| frame_path_enable={FRAME_PATH_ENABLE}"
                    )

                    # Stage: run alert identification against the detection results
                    self.logger.info(
                        f"[DETECT] START | frame_id={frame_id} | camera={camera_name} "
                        f"| detection_count={len(detection) if detection else 0} "
                        f"| from={self.consumer_topic}"
                    )
                    alert_result = await self.process_detection(detection, camera_name=camera_name)
                    if alert_result is None:
                        self.logger.error(
                            f"[SKIP] process_detection returned None | camera={camera_name} | frame_id={frame_id}"
                        )
                        continue
                    alert_result = alert_result.to_dict()
                    alert_result['frame_id'] = frame_id
                    self.logger.info(
                        f"[DETECT] DONE | frame_id={frame_id} | camera={camera_name} "
                        f"| alerts={alert_result.get('alert_results')} "
                        f"| no_object_status={alert_result.get('no_object_status')}"
                    )

                    # Stage: build output payload and publish to post_processing topic
                    if alert_result:
                        output_payload = {
                            "frame_id": frame_id,
                            "camera_name": camera_name,
                            "frame_path": frame_path,
                            "frame_bytes": frame_bytes,
                            "alert_results": alert_result.get('alert_results'),
                            "no_object_status": alert_result.get('no_object_status'),
                            'detection_results': alert_result.get('detection_results'),
                            'alert_description': alert_result.get('alert_description'),
                            'alert_notification_validity': alert_result.get('alert_notification_validity'),
                            'noobj_alert_result_config': alert_result.get('noobj_alert_result_config'),
                            'alert_result_config': alert_result.get('alert_result_config')
                        }
                        # Explicit partition map: each camera gets its own partition index
                        # (built from sorted MongoDB camera list at startup). Falls back to
                        # key-only murmur2 routing if map wasn't populated.
                        _send_kwargs: dict = dict(
                            key=camera_name.encode("utf-8"),
                            headers=list(message.headers)
                        )
                        # Distribute by frame_id hash so busy cameras spread across all
                        # partitions instead of concentrating on one (avoids hot spots).
                        _send_kwargs["partition"] = int(hashlib.md5(frame_id.encode()).hexdigest(), 16) % self._num_partitions
                        await self.producer.send(
                            self.producer_topic,
                            output_payload,
                            **_send_kwargs
                        )
                        self.logger.info(
                            f"[Result] frame_id={frame_id} | camera={camera_name} "
                            f"| alerts={alert_result.get('alert_results')} "
                            f"| no_object_status={alert_result.get('no_object_status')} "
                            f"| sent_to={self.producer_topic}"
                        )

                    # Stage: commit offsets every COMMIT_INTERVAL messages to limit replay window on restart
                    commit_count += 1
                    if commit_count >= COMMIT_INTERVAL:
                        await self.consumer.commit()
                        self.logger.info(f"Kafka offsets committed | messages_since_last_commit={COMMIT_INTERVAL}")
                        commit_count = 0

                except Exception as e:
                    self.logger.error(f"Error processing message: {e}")

        except Exception as e:
            self.logger.error(f"Error in message processing loop: {e}")
            raise

# -------------------- ENTRYPOINT --------------------

if __name__ == "__main__":

    def define_logger(logger_path):
        import logging.handlers, gzip, shutil, socket
        os.makedirs(logger_path, exist_ok=True)
        _hostname = socket.gethostname()
        log_file = f"{logger_path}/alert_identification_{_hostname}.log"
        fmt = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
        handler = logging.handlers.TimedRotatingFileHandler(
            filename=log_file, when='midnight', interval=1, backupCount=30, encoding='utf-8'
        )
        def _rotator(source, dest):
            with open(source, 'rb') as f_in, gzip.open(dest, 'wb') as f_out:
                shutil.copyfileobj(f_in, f_out)
            os.remove(source)
        handler.rotator = _rotator
        handler.namer = lambda n: n + ".gz"
        handler.setFormatter(fmt)
        _logger = logging.getLogger(f"alert_identification_{_hostname}")
        _logger.setLevel(logging.INFO)
        _logger.propagate = False
        if not _logger.handlers:
            _logger.addHandler(handler)
        return _logger

    main_dir = os.getenv("AKSHA_PATH")
    logger_path = os.path.join(main_dir, "log")
    logger = define_logger(logger_path)

    logger.info(
        f"Alert identification service starting | pipeline: object_detection_results → alert_identification → post_processing "
        f"| KAFKA={KAFKA_SERVER} | REDIS={REDIS_HOST}:{REDIS_PORT} | MONGO={MONGODB_URI} "
        f"| frame_path_enable={FRAME_PATH_ENABLE}"
    )

    async def main():
        # Stage: instantiate and run the alert service; stop cleanly on any error
        service = KafkaAlertService(
            kafka_bootstrap_servers=KAFKA_SERVER,
            redis_host=REDIS_HOST,
            redis_port=REDIS_PORT,
            mongo_uri=MONGODB_URI,
            consumer_topic="object_detection_results",
            producer_topic="post_processing",
            logger=logger
        )
        try:
            logger.info("Starting KafkaAlertService")
            await service.start()
        except Exception as e:
            logger.error(f"Error while starting KafkaAlertService: {e}")
        finally:
            logger.info("Stopping KafkaAlertService")
            await service.stop()

    asyncio.run(main())
