"""
ppe_alert_consumer.py — standalone Kafka consumer for ppe_results.

Runs as its own independent process/container (NOT merged into main.py's
event loop). This isolation avoids event-loop contention between two
AIOKafkaConsumer/Producer pairs sharing one process, which caused
persistent coordinator/rebalancing failures when both were run together
via asyncio.gather() in a single process.

Per colleague decision: ALL PPE results are forwarded regardless of
severity (including severity="none" / fully compliant) — this is a
continuous PPE compliance stream, not a violation-only alert filter.
"""

import json
import asyncio
import os
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer


def load_kafka_config():
    KAFKA_SERVER = os.environ.get("KAFKA_BOOTSTRAP_SERVERS")
    if not KAFKA_SERVER:
        if os.path.exists("/.dockerenv"):
            KAFKA_SERVER = "broker:9092"
        else:
            KAFKA_SERVER = "localhost:9092"
    return KAFKA_SERVER


KAFKA_SERVER = load_kafka_config()


def define_logger(logger_path):
    import logging, logging.handlers, gzip, shutil, socket
    os.makedirs(logger_path, exist_ok=True)
    _hostname = socket.gethostname()
    log_file = f"{logger_path}/ppe_alert_consumer_{_hostname}.log"
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
    _logger = logging.getLogger(f"ppe_alert_consumer_{_hostname}")
    _logger.setLevel(logging.INFO)
    _logger.propagate = False
    if not _logger.handlers:
        _logger.addHandler(handler)
    return _logger


async def process_ppe_messages(consumer, producer, logger):
    """Consume ppe_results, transform, forward to post_processing."""
    logger.info("Entering PPE message processing loop | ppe_results → ppe_alert_consumer → post_processing")
    try:
        async for message in consumer:
            try:
                payload = message.value
                cam_name = payload.get("cam_name")
                severity = payload.get("severity")
                logger.info(
                    f"[PPE FRAME RECEIVED] camera={cam_name} | severity={severity} "
                    f"| violated={payload.get('violated')}"
                )

                output_payload = {
                    "alert_type": "ppe",
                    "camera_name": cam_name,
                    "person_bbox": payload.get("person_bbox"),
                    "worn": payload.get("worn"),
                    "violated": payload.get("violated"),
                    "missing": payload.get("missing"),
                    "severity": severity,
                    "ppe_detections": payload.get("ppe_detections"),
                    "frame": payload.get("frame"),
                    "person_crop": payload.get("person_crop"),
                }

                await producer.send(
                    "post_processing",
                    output_payload,
                    key=cam_name.encode("utf-8") if cam_name else None,
                )
                logger.info(f"[PPE Result] camera={cam_name} | severity={severity} | sent_to=post_processing")

            except Exception as e:
                logger.error(f"Error processing PPE message: {e}")

    except Exception as e:
        logger.error(f"Error in PPE message processing loop: {e}")
        raise


async def main():
    main_dir = os.getenv("AKSHA_PATH")
    logger_path = os.path.join(main_dir, "log")
    logger = define_logger(logger_path)

    logger.info(
        f"PPE alert consumer starting | pipeline: ppe_results → ppe_alert_consumer → post_processing "
        f"| KAFKA={KAFKA_SERVER}"
    )

    consumer = AIOKafkaConsumer(
        "ppe_results",
        bootstrap_servers=KAFKA_SERVER,
        group_id="alert-service-ppe-group",
        value_deserializer=lambda m: json.loads(m.decode('utf-8')),
        enable_auto_commit=True,
        max_poll_records=1,
    )
    producer = AIOKafkaProducer(
        bootstrap_servers=KAFKA_SERVER,
        value_serializer=lambda m: json.dumps(m).encode('utf-8'),
    )

    try:
        await consumer.start()
        await producer.start()
        logger.info("PPE Kafka consumer/producer started | topic=ppe_results")
        await process_ppe_messages(consumer, producer, logger)
    except Exception as e:
        logger.error(f"Error while starting PPE alert consumer: {e}")
    finally:
        logger.info("Stopping PPE alert consumer")
        await consumer.stop()
        await producer.stop()


if __name__ == "__main__":
    asyncio.run(main())