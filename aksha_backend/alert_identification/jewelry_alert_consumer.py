"""
jewelry_alert_consumer.py — standalone Kafka consumer for jewelry_results.

Runs as its own independent process/container (NOT merged into main.py's
event loop), for the same reason ppe_alert_consumer.py does: isolation avoids
event-loop contention between multiple AIOKafkaConsumer/Producer pairs sharing
one process.

Unlike PPE's continuous compliance stream, jewelry rules only emit on genuine
trigger (see jewelry_rules.AlertBus — each rule already cooldown-gates itself),
so every message forwarded here represents an actual fired rule, not a
per-frame compliance sample.
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
    log_file = f"{logger_path}/jewelry_alert_consumer_{_hostname}.log"
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
    _logger = logging.getLogger(f"jewelry_alert_consumer_{_hostname}")
    _logger.setLevel(logging.INFO)
    _logger.propagate = False
    if not _logger.handlers:
        _logger.addHandler(handler)
    return _logger


async def process_jewelry_messages(consumer, producer, logger):
    """Consume jewelry_results, transform, forward to post_processing."""
    logger.info("Entering jewelry message processing loop | jewelry_results → jewelry_alert_consumer → post_processing")
    try:
        async for message in consumer:
            try:
                payload = message.value
                cam_name = payload.get("camera_name")
                rule = payload.get("rule")
                severity = payload.get("severity")
                logger.info(
                    f"[JEWELRY EVENT RECEIVED] camera={cam_name} | rule={rule} | severity={severity}"
                )

                output_payload = {
                    "alert_type": "jewelry",
                    "camera_name": cam_name,
                    "rule": rule,
                    "severity": severity,
                    "confidence": payload.get("confidence"),
                    "track_id": payload.get("track_id"),
                    "zone": payload.get("zone"),
                    "bbox": payload.get("bbox"),
                    "metadata": payload.get("metadata"),
                    "frame": payload.get("frame"),
                }

                await producer.send(
                    "post_processing",
                    output_payload,
                    key=cam_name.encode("utf-8") if cam_name else None,
                )
                logger.info(f"[Jewelry Result] camera={cam_name} | rule={rule} | sent_to=post_processing")

            except Exception as e:
                logger.error(f"Error processing jewelry message: {e}")

    except Exception as e:
        logger.error(f"Error in jewelry message processing loop: {e}")
        raise


async def main():
    main_dir = os.getenv("AKSHA_PATH")
    logger_path = os.path.join(main_dir, "log")
    logger = define_logger(logger_path)

    logger.info(
        f"Jewelry alert consumer starting | pipeline: jewelry_results → jewelry_alert_consumer → post_processing "
        f"| KAFKA={KAFKA_SERVER}"
    )

    consumer = AIOKafkaConsumer(
        "jewelry_results",
        bootstrap_servers=KAFKA_SERVER,
        group_id="alert-service-jewelry-group",
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
        logger.info("Jewelry Kafka consumer/producer started | topic=jewelry_results")
        await process_jewelry_messages(consumer, producer, logger)
    except Exception as e:
        logger.error(f"Error while starting jewelry alert consumer: {e}")
    finally:
        logger.info("Stopping jewelry alert consumer")
        await consumer.stop()
        await producer.stop()


if __name__ == "__main__":
    asyncio.run(main())
