"""
main.py — Jewelry container entrypoint.

Launched by the Docker controller (deployment_mode='jewelry') via CLI args:
    python3 main.py --camera_name ... --rtsp_id ... --rtsp_url ...
                     --output_width ... --output_height ... --fps ...
                     --prefilter_threshold ...

Launched by the Kubernetes controller via env vars instead (its per-camera
Deployment builder — see controller_kubernetes/app/main.py's
start_frame_reader()/_common_env() — sets CAMERA_NAME/RTSP_ID/RTSP_URL/
OUTPUT_WIDTH/OUTPUT_HEIGHT/FPS as container env, not a custom command). Every
arg below falls back to its matching env var so the same image runs under
either controller unchanged.

prefilter_threshold is accepted for interface compatibility with the Docker
controller's launch command but is currently unused.
"""

import argparse
import os
import sys

from jewelry_reader import read_jewelry_frames

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--camera_name", default=os.environ.get("CAMERA_NAME"))
    parser.add_argument("--rtsp_id", default=os.environ.get("RTSP_ID"))
    parser.add_argument("--rtsp_url", default=os.environ.get("RTSP_URL"))
    parser.add_argument("--output_width", type=int, default=int(os.environ.get("OUTPUT_WIDTH", 640)))
    parser.add_argument("--output_height", type=int, default=int(os.environ.get("OUTPUT_HEIGHT", 360)))
    parser.add_argument("--fps", type=float, default=float(os.environ.get("FPS", 1.0)))
    parser.add_argument("--prefilter_threshold", type=float,
                         default=float(os.environ.get("SSIM_THRESH", 0.95)))  # unused, kept for compatibility
    args = parser.parse_args()

    if not args.camera_name or not args.rtsp_id or not args.rtsp_url:
        sys.exit("camera_name, rtsp_id and rtsp_url are required (via --flag or CAMERA_NAME/RTSP_ID/RTSP_URL env vars)")

    output_size = (args.output_width, args.output_height)

    read_jewelry_frames(
        camera_name=args.camera_name,
        rtsp_id=args.rtsp_id,
        video_path=args.rtsp_url,
        fps=args.fps,
        output_size=output_size,
    )
