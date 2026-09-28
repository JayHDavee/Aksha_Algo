"""
create_input_video — stitch sorted JPEG frames into a single MP4 for heatmap processing.

Used by insight.create_heatmap() as Step 3 of the heatmap pipeline.
Output path: {work_dir}/{Camera_name}/insight/input_video_{Camera_name}.mp4
Frame rate: 40 fps — higher than playback rate so the heatmap accumulation covers
            the full motion range without producing an overly long video.
"""

import cv2
import os
import logging


def create_video_from_frames(frames, work_dir, Camera_name, logger):
    """
    Write sorted JPEG *frames* into an MP4 and return the output path.

    Frame resolution is taken from the first frame — all frames must be the same size.
    The video is encoded with the mp4v fourcc codec so it is readable by OpenCV's
    VideoCapture in output_video.py without requiring ffmpeg at this stage.
    """
    try:
        # Filter for JPEG files only and sort chronologically (filenames are timestamps)
        frame_files = sorted(f for f in frames if f.endswith(".jpg"))
        input_video_path = f'{work_dir}/{Camera_name}/insight/input_video_{Camera_name}.mp4'
        frame_rate = 40  # fast enough to capture motion without a very long video

        # Determine frame dimensions from the first file
        first_frame = cv2.imread(frame_files[0])
        height, width, _ = first_frame.shape

        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        video_writer = cv2.VideoWriter(input_video_path, fourcc, frame_rate, (width, height))

        for frame_file in frame_files:
            frame = cv2.imread(frame_file)
            video_writer.write(frame)

        video_writer.release()
        logger.info(f"Input video created | path={input_video_path} | frames={len(frame_files)}")
        return input_video_path

    except Exception as e:
        logger.error(f"Exception in create_input_video: {e}")
        raise
