"""
insight — heatmap generation for the /Insight endpoint.

Pipeline:

  camera name + time range
    → get_diff_files()          glob stored frame JPEGs, filter by date+hour+minute
    → create_video_from_frames() stitch JPEGs into an input MP4 at 40 fps
    → heatmap_video()            MOG background subtraction → accumulated heat overlay
                                  → ffmpeg encode → heatmap_video_{cam}.mp4
                                  → heatmap_img_{cam}.jpg  (final still overlay)
    → cleanup                    remove input video + heatmap/frames/ temp directory

Output files written to:  AKSHA_PATH/{camera}/insight/
"""

import numpy as np
import cv2
import glob
from datetime import datetime, timedelta
import os
import shutil
import logging
import sys


def get_diff_files(Start_date: str, End_date: str, Start_time: str, End_time: str,
                   Camera_name: str, work_dir, logger):
    """
    Return a sorted list of JPEG frame paths that fall within the requested time window.

    Frames are stored under {work_dir}/{Camera_name}/frame/{date}/*.jpg.
    Filenames encode the capture timestamp as YYYY-MM-DD_HH:MM:SS[.ffffff].
    Minutes at the exact boundary hours are trimmed using a support_list pass.
    """
    startD = datetime.strptime(Start_date, '%Y-%m-%d').date()
    endD   = datetime.strptime(End_date,   '%Y-%m-%d').date()
    startT = datetime.strptime(Start_time, '%H:%M:%S').time().hour
    endT   = datetime.strptime(End_time,   '%H:%M:%S').time().hour
    startm = datetime.strptime(Start_time, '%H:%M:%S').time().minute
    endm   = datetime.strptime(End_time,   '%H:%M:%S').time().minute
    currentDate = startD

    diff_files = []
    while currentDate <= endD:
        frame_path = f"{work_dir}/{Camera_name}/frame/{currentDate}/*.jpg"
        for filename in glob.glob(frame_path):
            try:
                filename_parts   = filename.split("/")[-1].rsplit(".", 1)[0]
                date_str         = filename_parts[:10]
                time_str         = filename_parts[11:]

                # Handle optional microseconds in the filename timestamp
                if "." in time_str:
                    time_without_ms          = time_str.split(".")[0]
                    image_timestamp_hour     = datetime.strptime(time_without_ms, '%H:%M:%S').time().hour
                else:
                    image_timestamp_hour     = datetime.strptime(time_str, '%H:%M:%S').time().hour

                image_timestamp_date = datetime.strptime(date_str, "%Y-%m-%d").date()

                # Include frames that fall within the requested date+hour window
                if image_timestamp_date == startD == endD and endT >= image_timestamp_hour >= startT:
                    diff_files.append(filename)
                elif startD != endD:
                    if image_timestamp_date == startD and image_timestamp_hour >= startT:
                        diff_files.append(filename)
                    elif startD < image_timestamp_date < endD:
                        diff_files.append(filename)
                    elif image_timestamp_date == endD and image_timestamp_hour <= endT:
                        diff_files.append(filename)
            except Exception as e:
                logger.error(f"Error parsing filename {filename}: {e}")
                continue
        currentDate += timedelta(days=1)

    # Second pass: drop frames in the boundary hours that fall outside the exact minute range
    support_list = []
    for i in diff_files:
        try:
            filename_parts = i.split("/")[-1].rsplit(".", 1)[0]
            date_str       = filename_parts[:10]
            time_str       = filename_parts[11:]
            if "." in time_str:
                time_obj = datetime.strptime(time_str.split(".")[0], '%H:%M:%S').time()
            else:
                time_obj = datetime.strptime(time_str, '%H:%M:%S').time()
            image_date   = datetime.strptime(date_str, "%Y-%m-%d").date()
            image_hour   = time_obj.hour
            image_minute = time_obj.minute
            # Mark frames before startm at the start hour, and after endm at the end hour
            if ((image_date == startD and image_hour == startT and image_minute < startm) or
                    (image_date == endD and image_hour == endT and image_minute > endm)):
                support_list.append(i)
        except Exception as e:
            logger.error(f"Error filtering file {i}: {e}")
            continue

    for j in diff_files[:]:
        if j in support_list:
            diff_files.remove(j)

    return diff_files


def create_heatmap(Start_date: str, End_date: str, Start_time: str, End_time: str,
                   Camera_name: str, work_dir, logger):
    """
    Orchestrate the full heatmap generation pipeline for one camera and time range.

    Steps:
      1. Clean stale heatmap files from the insight directory.
      2. Collect frame paths via get_diff_files().
      3. Stitch into an input MP4 (create_input_video).
      4. Run MOG background subtraction + heat accumulation (output_video).
      5. Remove temporary files (input video, heatmap/frames/).
    """
    start_time_exec = datetime.now()

    # Remove any stale heatmap outputs from a previous run
    try:
        insight_dir = f'{work_dir}/{Camera_name}/insight'
        if os.path.exists(insight_dir):
            for file in os.listdir(insight_dir):
                if file.startswith('heatmap_video_') or file.startswith('converted_heatmap_video_'):
                    os.remove(os.path.join(insight_dir, file))
    except Exception as e:
        logger.warning(f"Could not clean insight directory: {e}")

    diff_files = get_diff_files(Start_date, End_date, Start_time, End_time, Camera_name, work_dir, logger)
    logger.info(f"Found {len(diff_files)} frames for heatmap processing | camera={Camera_name}")

    if len(diff_files) == 0:
        logger.warning(f"No frames found for heatmap | camera={Camera_name}")
        return "No frames found for the specified date range"

    try:
        # Import video helpers — try relative first (when run as package), fall back to absolute
        try:
            from . import create_input_video as ci
            from . import output_video as ov
            logger.info("Imported video modules (relative)")
        except ImportError as e:
            logger.warning(f"Relative import failed ({e}) — trying absolute")
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import create_input_video as ci
            import output_video as ov
            logger.info("Imported video modules (absolute)")

        # Step 3: stitch frames into a single input MP4
        logger.info(f"Creating input video | camera={Camera_name}")
        input_video_path = ci.create_video_from_frames(diff_files, work_dir, Camera_name, logger)
        logger.info(f"Input video created | path={input_video_path}")

        # Step 4: run the heatmap algorithm over the input video
        logger.info(f"Running heatmap algorithm | camera={Camera_name}")
        heatmap_vid_path = ov.heatmap_video(input_video_path, work_dir, Camera_name, logger)
        logger.info(f"Heatmap video created | path={heatmap_vid_path}")

        # Step 5: remove temporary artefacts to keep the insight directory clean
        try:
            if os.path.exists(input_video_path):
                os.remove(input_video_path)
                logger.info(f"Removed input video: {input_video_path}")
        except Exception as e:
            logger.warning(f"Could not remove input video: {e}")

        try:
            heatmap_dir = f'{work_dir}/{Camera_name}/insight/heatmap'
            if os.path.exists(heatmap_dir):
                shutil.rmtree(heatmap_dir)
                logger.info(f"Removed heatmap temp directory: {heatmap_dir}")
        except Exception as e:
            logger.warning(f"Could not remove heatmap temp directory: {e}")

        elapsed = (datetime.now() - start_time_exec).total_seconds()
        logger.info(f"Heatmap generation complete | camera={Camera_name} | elapsed={elapsed:.1f}s")
        return f"Heatmap video created: {heatmap_vid_path}"

    except Exception as e:
        logger.error(f"Error generating heatmap | camera={Camera_name}: {e}")
        import traceback
        logger.error(traceback.format_exc())
        raise
