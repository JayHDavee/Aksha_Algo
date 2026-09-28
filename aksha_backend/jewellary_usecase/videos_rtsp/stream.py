import subprocess
import time
import signal
import sys
from pathlib import Path

# -----------------------------
# CONFIG
# -----------------------------
VIDEO_PATH = "./videos/sample.mp4"  # path to your video
RTSP_HOST = "192.168.1.74"          # your fixed host IP
RTSP_PORT = 8554
TOTAL_STREAMS = 11           # number of RTSP streams

processes = []

# -----------------------------
# Start individual FFmpeg stream
# -----------------------------
def start_stream(video_path, stream_id):
    rtsp_url = f"rtsp://{RTSP_HOST}:{RTSP_PORT}/test{stream_id}"

    cmd = [
        "ffmpeg",
        "-re",
        "-stream_loop", "-1",      # loop infinitely
        "-fflags", "+genpts",
        "-i", str(video_path),
        "-map", "0:v:0",
        "-vsync", "cfr",
        "-r", "25",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        "-g", "50",
        "-keyint_min", "50",
        "-pix_fmt", "yuv420p",
        "-f", "rtsp",
        "-rtsp_transport", "tcp",
        rtsp_url
    ]

    print(f"[INFO] Starting stream {stream_id} → {rtsp_url}")
    return subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )

# -----------------------------
# Handle shutdown
# -----------------------------
def shutdown(signum, frame):
    print("\n[INFO] Shutting down RTSP streams...")
    for p in processes:
        if p.poll() is None:
            p.terminate()
    sys.exit(0)

signal.signal(signal.SIGINT, shutdown)
signal.signal(signal.SIGTERM, shutdown)

# -----------------------------
# Check video exists
# -----------------------------
video_file = Path(VIDEO_PATH)
if not video_file.exists():
    print("[ERROR] Video file not found:", VIDEO_PATH)
    sys.exit(1)

# -----------------------------
# Start all streams
# -----------------------------
for i in range(1, TOTAL_STREAMS + 1):
    proc = start_stream(video_file, i)
    processes.append(proc)
    time.sleep(0.3)  # avoid RTSP bind race

print(f"[INFO] {TOTAL_STREAMS} RTSP streams running on {RTSP_HOST}:{RTSP_PORT}")
print("[INFO] Press Ctrl+C to stop")

# -----------------------------
# Keep script alive
# -----------------------------
while True:
    time.sleep(5)