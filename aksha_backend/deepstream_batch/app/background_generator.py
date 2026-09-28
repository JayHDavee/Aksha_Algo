"""
background_generator — rolling background model for per-camera scene baseline.

Update schedule:

  Every 5 min  (generate_daily_background_images)
    daily_frames (≤30) ──┐
    daily_frames_temp ───┼──→ np.median (pixel-wise) ──→ daily_background_hour_{H}.jpg
    current_frame ───────┘   fallback when no frames available

  Every 1 hour (update_background_video_frames)
    new daily_frames (sample ≤10) ──┐
    existing video frames  (≤70)  ──┴──→ background_data_{H}.mp4  (5 fps, 256×256)

  Every week  (generate_weekly_background, called at 00:00)
    background_data_{H}.mp4  ──→ np.median ──→ weekly_background_hour_{H}.jpg
    (processed independently for each of the 24 hours)
"""

import cv2
import numpy as np
import os
from datetime import timedelta
import random

# ── Daily background generation ───────────────────────────────────────────────
def update_background_video_frames(timestamp, background_path, daily_frames, logger):
    """
    Function to add & update background frames to hourly background video file.

    timestamp : Date and time
    background_path : Path of background folder where videos are stored
    daily_frames: List of frames to be added into that hourly background video
    logger : Logger to save logs

    Returns : None
    """
    try :
        # Use the previous hour's video file — this is called at the hour boundary,
        # so we write into the bucket that just completed, not the one that just started
        hour = (timestamp-timedelta(hours=1)).hour
        logger.info(msg=f"Adding background video frames for Hour : {hour}")

        # Load existing frames from the stored hourly video
        frames = extract_frames(background_path=background_path, hour=hour, logger=logger)

        logger.info(msg=f'Total no. of frames from existing hour : {hour} video: {len(frames)}')
        logger.info(msg=f'Total no. of frames to be appended : {len(daily_frames)}')

        if len(frames) >= 70:
            # Cap the rolling window at 70 frames — keep the most recent ones
            frames = frames[-70:]

        if len(daily_frames) < 10:
            # Fewer than 10 new frames — include all to avoid losing data
            frames = frames + daily_frames
        else:
            # More than 10 new frames — randomly sample 10 to keep the video size bounded
            # and avoid bias toward any particular time segment within the hour
            frames = frames + random.sample(daily_frames, 10)

        logger.info(msg=f"Total no. of frames after combining existing frames & new daily frames:  {len(frames)}")

        # Overwrite the hour's video with the updated frame list
        # 5 fps, 256×256 — small enough to keep disk usage low across 24 hours
        out = cv2.VideoWriter(f'{background_path}/background_data_{hour}.mp4',cv2.VideoWriter_fourcc(*'mp4v'), 5, (256,256))
        for j in frames:
            out.write(j)
        out.release()
        logger.info(msg=f"Background frames added to video for Hour : {hour}")
    except Exception as e:
        logger.error(f"error occurred in updating background video frames : {e}")

def generate_daily_background_images(timestamp, background_path, daily_frames, daily_frames_temp, current_frame, logger):
    """
    to generate daily background image (every 5 minutes) and add frames into the background video file.

    Args:
        timestamp (datetime.datetime): frame timestamp
        background_path: Path of background folder where videos are stored
        daily_frames: List of frames to be added into that hourly background video
        current_frame :
        logger : Logger to save logs

    """
    try:
        hour = timestamp.hour
        logger.info(msg=f">>>>>>>>>>>>>>>>>>>>>>>>>>>>Generating daily background images<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<")
        logger.info(msg=f"--------daily frames: {len(daily_frames)}---------")
        logger.info(msg=f"--------daily_frames_temp: {len(daily_frames_temp)}---------")
        median_frame = None

        # Resize to 256×256 to match the stored video resolution before taking the median
        current_frame = cv2.resize(current_frame, (256, 256))

        if daily_frames:
            if len(daily_frames) < 30 and daily_frames_temp:
                # Not enough daily frames on their own — pad with the most recent frames from
                # the previous period (daily_frames_temp) to reach at least 30 samples
                combined_frames = daily_frames + daily_frames_temp[-(30 - len(daily_frames)):]
                median_frame = np.median(combined_frames, axis=0).astype(dtype=np.uint8)
                logger.info(msg=f"median frame uses daily frames and daily_frames_temp")
            else:
                # Sufficient daily frames — compute median without mixing in the temp buffer
                median_frame = np.median(daily_frames, axis=0).astype(dtype=np.uint8)
                logger.info(msg=f"median frame uses daily frames only")

        elif daily_frames_temp:
            # No daily frames at all — fall back entirely to the previous period's buffer
            median_frame = np.median(daily_frames_temp, axis=0).astype(dtype=np.uint8)
            logger.info(msg=f"median frame uses daily_frames_temp only")

        elif not os.path.exists(f'{background_path}/daily_background_hour_{hour}.jpg'):
            # No frames of any kind and no existing background — use the current frame
            # as a placeholder so downstream processes always find a background image
            median_frame = current_frame
            logger.info(msg=f"median frame uses current_frame")
        # else: a background already exists and we have no new data — leave it unchanged

        if median_frame is not None:
            # Overwrite the hourly background JPEG with the freshly computed median
            cv2.imwrite(f'{background_path}/daily_background_hour_{hour}.jpg', median_frame)
            logger.info(msg=f"daily background image saved successfully!")

    except Exception as e:
        logger.error(f"error occurred in generate_daily_background: {e}")


def extract_frames(background_path, hour, logger):
    """
    Function to extract frames from a given video.

    background_path : Path of background folder where videos are stored
    hour : Hour for which frames are to be extracted (in 24 hr format)
    logger : Logger to save logs

    Returns
    frames : List of extracted frames
    """
    try:
        video = cv2.VideoCapture(f'{background_path}/background_data_{hour}.mp4')
        frames = []
        while video.isOpened():
            ret, frame = video.read()
            if not ret:
                break  # end of file or read error — stop extracting
            frames.append(frame)
        video.release()
        return frames
    except Exception as e:
        logger.error(f"Error occurred in extracting frames from videos for hour- {hour}: {e}")
        return []   # callers do len(frames) — None would raise TypeError


#-------------------------------------Weekly background generation---------------------------------------

def generate_weekly_background(background_path, logger):
    """
    Function to generate weekly background image from stored video(at "00:00:00") for all hours individually

    background_path : Path of background folder where videos are stored
    logger : Logger to save logs
   """
    # Process each hour independently so a failure in one hour doesn't block the rest
    for hour in range(24):
        try :
            # Pull all stored frames for this hour from the rolling video file
            frames = extract_frames(background_path=background_path, hour=hour, logger=logger)
            if frames:
                logger.info(msg=f"Total weekly frames from {hour} hour video : {len(frames)}")
                # Pixel-wise median over the week's frames — static background objects cancel
                # out moving foreground, giving a clean scene background for this hour
                cv2.imwrite(
                    background_path + f'/weekly_background_hour_{hour}.jpg',
                    np.median(frames, axis=0).astype(dtype=np.uint8)
                )
                logger.info(msg=f"Weekly background image saved for Hour : {hour}")

        except Exception as e:
            logger.error(f"Error occurred in generating weekly background image for Hour : {hour} due to : {e}")

