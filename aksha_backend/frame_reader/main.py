"""
main.py  —  Frame Reader Service Entry Point
=============================================

Architecture Overview
----------------------

    ┌──────────────────────────────────────────────────────────────────────┐
    │                      FRAME READER SERVICE                            │
    │                                                                      │
    │  One container per camera  (deployed by docker-compose / k8s)        │
    │                                                                      │
    │  Inputs (CLI args / environment variables)                           │
    │    CAMERA_NAME         str    unique camera identifier               │
    │    RTSP_ID             str    unique RTSP stream identifier          │
    │    RTSP_URL            str    RTSP stream URL (or numeric device id) │
    │    OUTPUT_WIDTH        int    frame width after resize               │
    │    OUTPUT_HEIGHT       int    frame height after resize              │
    │    OBJECT_DETECTION    bool   enable object detection path           │
    │    ANOMALY_DETECTION   bool   enable anomaly background modelling    │
    │    FPS                 float  target frames-per-second to publish    │
    │    SSIM_THRESH         float  SSIM similarity threshold (0–1)        │
    │                                                                      │
    │  Startup sequence                                                    │
    │    1. Parse CLI / env args                                           │
    │    2. dir_setup(camera_name)   → create all per-camera directories  │
    │    3. read_frames(...)         → start grab/filter/publish loop      │
    │                                                                      │
    │  Data flow                                                           │
    │    RTSP stream                                                       │
    │      └── cv2.VideoCapture                                            │
    │            └── grab → skip_rate filter → retrieve (decode)          │
    │                  └── SSIM pre-filter (skip static frames)           │
    │                        └── Kafka produce  →  topic: raw_frame       │
    │                              └── background_generator (anomaly)     │
    └──────────────────────────────────────────────────────────────────────┘

CLI / environment variable mapping
------------------------------------
Every argument has a matching environment variable so the container can be
configured purely via docker-compose environment blocks without passing
explicit CLI flags.  CLI flags take precedence over env vars.

Example run (local dev)
-----------------------
  python main.py \\
    --camera_name cam801 \\
    --rtsp_url rtsp://admin:pass@192.168.1.20:554/Streaming/Channels/101 \\
    --output_height 360 --output_width 640 \\
    --object_detection True --anomaly_detection False \\
    --fps 0.5 --prefilter_threshold 0.95
"""

# ── Standard library ──────────────────────────────────────────────────────────
import os        # os.environ.get for default values
import argparse  # CLI argument parsing

# ── Internal modules ──────────────────────────────────────────────────────────
from frame_reader import read_frames   # main grab/filter/publish loop
from utils import dir_setup            # per-camera directory initialisation


# ══════════════════════════════════════════════════════════════════════════════
# Argument parser
# Each argument maps directly to an environment variable so the service can
# be launched from docker-compose without any CLI flags.
# ══════════════════════════════════════════════════════════════════════════════

parser = argparse.ArgumentParser(
    description="Aksha Frame Reader — captures RTSP frames and publishes to Kafka"
)

# Camera identity
parser.add_argument(
    '--camera_name',
    help="Unique camera identifier (e.g. 'cam101').  Env: CAMERA_NAME",
    default=os.environ.get("CAMERA_NAME")
)

parser.add_argument(
    '--rtsp_id',
    help="Unique RTSP stream identifier used for reference-image filenames.  Env: RTSP_ID",
    default=os.environ.get("RTSP_ID")
)

parser.add_argument(
    '--rtsp_url',
    help="Full RTSP URL of the camera stream, or a numeric device index for local webcam.  Env: RTSP_URL",
    type=str,
    default=os.environ.get("RTSP_URL")
)

# Output resolution — frames are resized to (output_width × output_height) before Kafka publish
parser.add_argument(
    '--output_width',
    help="Frame width in pixels after resize (e.g. 640).  Env: OUTPUT_WIDTH",
    type=int,
    default=str(os.environ.get("OUTPUT_WIDTH"))   # str() so int() parse works on None
)

parser.add_argument(
    '--output_height',
    help="Frame height in pixels after resize (e.g. 360).  Env: OUTPUT_HEIGHT",
    type=int,
    default=str(os.environ.get("OUTPUT_HEIGHT"))
)

# Detection flags
parser.add_argument(
    '--object_detection',
    help="Enable object detection pipeline downstream.  Env: OBJECT_DETECTION",
    type=bool,
    default=bool(os.environ.get("OBJECT_DETECTION"))
)

parser.add_argument(
    '--anomaly_detection',
    help="Enable anomaly detection background modelling.  Env: ANOMALY_DETECTION",
    type=bool,
    default=bool(os.environ.get("ANOMALY_DETECTION"))
)

# Frame-rate target — frames are sub-sampled to this rate before publishing
parser.add_argument(
    '--fps',
    help="Target frames-per-second to publish to Kafka (e.g. 0.5, 1.0, 3.0).  Env: FPS",
    type=float,
    default=float(os.environ.get("FPS"))
)

# SSIM pre-filter threshold — scenes with similarity above this are skipped
parser.add_argument(
    '--prefilter_threshold',
    help=(
        "SSIM similarity threshold (0.0–1.0).  Frames where SSIM between consecutive "
        "frames exceeds this value are not published (scene unchanged).  Env: SSIM_THRESH"
    ),
    type=float,
    default=float(os.environ.get("SSIM_THRESH"))
)

args = parser.parse_args()

# Example docker run command for reference:
# sudo docker run -it --name frame_reader_container \
#   -e FPS=1.0 -e SSIM_THRESH=0.95 frame_reader:test \
#   python3 main.py --camera_name cam101 \
#   --rtsp_url rtsp://admin:CCTV2024@192.168.1.20:554/Streaming/Channels/101 \
#   --output_width 640 --output_height 360 \
#   --object_detection True --anomaly_detection True \
#   --fps 1.0 --prefilter_threshold 0.95


# ══════════════════════════════════════════════════════════════════════════════
# Entrypoint
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    # Pack width+height into a tuple expected by cv2.resize and frame_reader
    output_size = (args.output_width, args.output_height)

    # Step 1: create all required per-camera directories under AKSHA_PATH
    # (frame/, alerts/, background/, foreground/, live/, spotlight/, etc.)
    dir_setup(camera_name=args.camera_name)

    # Step 2: start the main frame-capture and publish loop (runs indefinitely)
    # frame_path_enable=False → embed JPEG bytes directly in the Kafka payload
    # (set True to save frames to disk and send file paths instead)
    read_frames(
        args.camera_name,
        args.rtsp_id,
        args.rtsp_url,
        args.fps,
        output_size,
        args.object_detection,
        args.anomaly_detection,
        args.prefilter_threshold,
        frame_path_enable=False
    )
