"""
main.py — PPE container entrypoint.

Launched by the Controller (deployment_mode='ppe') via:
    python3 main.py --camera_name ... --rtsp_id ... --rtsp_url ...
                     --output_width ... --output_height ... --fps ...
                     --prefilter_threshold ...

This replaces the old Kafka-consumer architecture (main.py consuming from
raw_frame, producing to ppe_detection_results). The new PPE container reads
RTSP directly (like frame_reader.py), runs PPE inference on every decoded
frame, saves annotated images, and publishes live view to the UI.

prefilter_threshold is accepted for interface compatibility with the
Controller's launch command but is currently unused (no SSIM pre-filter
in this Step 4 implementation — every decoded frame is processed).
"""

import argparse
from ppe_reader import read_ppe_frames

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--camera_name", required=True)
    parser.add_argument("--rtsp_id", required=True)
    parser.add_argument("--rtsp_url", required=True)
    parser.add_argument("--output_width", type=int, default=640)
    parser.add_argument("--output_height", type=int, default=360)
    parser.add_argument("--fps", type=float, default=1.0)
    parser.add_argument("--prefilter_threshold", type=float, default=0.95)  # unused, kept for compatibility
    args = parser.parse_args()

    output_size = (args.output_width, args.output_height)

    read_ppe_frames(
        camera_name=args.camera_name,
        rtsp_id=args.rtsp_id,
        video_path=args.rtsp_url,
        fps=args.fps,
        output_size=output_size,
    )