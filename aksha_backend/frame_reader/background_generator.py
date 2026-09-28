"""
background_generator.py  —  Anomaly Detection Background Model Builder
=======================================================================

Architecture Overview
----------------------

    ┌──────────────────────────────────────────────────────────────────────┐
    │             BACKGROUND MODEL UPDATE SCHEDULE                         │
    │                                                                      │
    │  frame_reader.py accumulates frames in daily_frames[]                │
    │  (one 256×256 BGR frame per second of stream time)                   │
    │                                                                      │
    │  Every 5 minutes   →  generate_daily_background_images()            │
    │  │  Computes median frame from daily_frames (+ daily_frames_temp    │
    │  │  fallback if sparse) and saves as:                               │
    │  │    background/daily_background_hour_<H>.jpg                      │
    │                                                                      │
    │  Every 1 hour      →  update_background_video_frames()              │
    │  │  Appends ~10 sampled daily_frames to the per-hour MP4 video:     │
    │  │    background/background_data_<H>.mp4                            │
    │  │  Maintains video at ≤ 80 total frames (oldest dropped first).    │
    │                                                                      │
    │  At midnight (00:00)  →  generate_weekly_background()               │
    │     Reads all 24 hourly MP4 videos, computes per-hour median, saves:│
    │       background/weekly_background_hour_<H>.jpg  (for H in 0..23)   │
    └──────────────────────────────────────────────────────────────────────┘

Background model files per camera
-----------------------------------
All files live under  ``<AKSHA_PATH>/<camera_name>/background/``:

  ``daily_background_hour_<H>.jpg``    (24 files, H = 0..23)
      Median frame computed every 5 minutes from the current hour's
      accumulated frames.  Used by the anomaly model as a per-hour
      reference for what the scene "normally" looks like.

  ``weekly_background_hour_<H>.jpg``   (24 files)
      Median frame computed at midnight from the entire hourly MP4 video.
      Covers a full week's worth of variation for more robust anomaly
      detection.

  ``background_data_<H>.mp4``          (24 files)
      Rolling MP4 video (256×256, 5 fps, up to 80 frames) that accumulates
      representative frames for each hour.  Updated every hour.

Frame accumulation strategy
-----------------------------
  - ``daily_frames``       — current hour's frames (cleared at the top of
                             each hour after the video-update thread runs)
  - ``daily_frames_temp``  — snapshot of the previous hour's frames
                             (used as a fallback when ``daily_frames`` has
                             fewer than 30 entries at the 5-minute update)

Median background computation
-------------------------------
``np.median(frames, axis=0).astype(np.uint8)`` averages out transient
objects (people, vehicles) across many frames, leaving only the static
background structure.  This is the canonical background subtraction
initialisation approach for unsupervised anomaly detection.

All functions in this module are called from daemon threads spawned by
``frame_reader.read_frames`` — they must be thread-safe and must not
mutate any shared mutable state without coordination.
"""

# ── Standard library ──────────────────────────────────────────────────────────
import os                    # path construction, makedirs, path existence checks
import random                # random.sample for frame subsampling

# ── Third-party ───────────────────────────────────────────────────────────────
import cv2                   # VideoCapture (read), VideoWriter (write), imwrite, resize
import numpy as np           # np.median for background computation
from datetime import timedelta  # subtract one hour for the previous-hour video path


# ══════════════════════════════════════════════════════════════════════════════
# update_background_video_frames  —  hourly MP4 accumulation
# ══════════════════════════════════════════════════════════════════════════════

def update_background_video_frames(timestamp, background_path, daily_frames, logger):
    """
    Append newly captured frames to the per-hour background MP4 video.

    Called once per hour (at the top of each hour) from a daemon thread.
    Reads the existing video for the *previous* hour (``timestamp - 1 h``),
    merges in a sample of the current ``daily_frames``, trims the total to
    at most 80 frames, and rewrites the video file.

    Frame sampling strategy
    -----------------------
    - If ``len(daily_frames) < 10``: include all of them (sparse hour).
    - If ``len(daily_frames) >= 10``: randomly sample 10 frames to keep
      the video representative without bloating it.

    Video trimming
    --------------
    The existing video is read into memory.  If it already has ≥ 70 frames,
    the oldest frames are dropped (``del frames[:excess]``) so the combined
    total stays ≤ 80 after appending.

    Output format
    -------------
    MP4 (``mp4v`` codec), 5 fps, 256×256 pixels, colour.
    Saved to ``<background_path>/background_data_<H>.mp4`` where ``H`` is
    the *previous* hour (0–23).

    Parameters
    ----------
    timestamp : datetime.datetime
        Current frame timestamp.  The target hour is ``timestamp.hour - 1``.
    background_path : str
        Path to the camera's background directory.
    daily_frames : list[np.ndarray]
        Accumulated 256×256 BGR frames from the current processing hour.
        This list is read-only here; the caller clears it after the call.
    logger : logging.Logger
        Shared frame-reader logger.
    """
    try:
        # Subtract one hour to get the index of the hour whose video we are updating.
        # At 09:00 we update the video for hour 8; at 00:00 we update hour 23.
        hour = (timestamp - timedelta(hours=1)).hour
        logger.info(msg=f"Adding background video frames for Hour : {hour}")

        # Read all existing frames from the previous-hour video (may be empty on first run)
        frames = extract_frames(background_path=background_path, hour=hour, logger=logger)
        logger.info(msg=f'Total no. of frames from existing hour : {hour} video: {len(frames)}')
        logger.info(msg=f'Total no. of frames to be appended : {len(daily_frames)}')

        # Trim existing frames so total after append stays ≤ 80
        # Example: existing=75, new=10 → drop 5 oldest → 70 + 10 = 80
        if len(frames) >= 70:
            del frames[:len(frames) - 70]   # drop oldest frames from the front

        # Merge: add all daily_frames if <10, else random sample of 10
        if len(daily_frames) < 10:
            frames = frames + daily_frames   # include all (sparse hour)
        else:
            frames = frames + random.sample(daily_frames, 10)   # random 10 for diversity

        logger.info(msg=f"Total no. of frames after combining existing frames & new daily frames:  {len(frames)}")

        # Rewrite the video file with the updated frames list
        out = cv2.VideoWriter(
            f'{background_path}/background_data_{hour}.mp4',
            cv2.VideoWriter_fourcc(*'mp4v'),   # MP4V codec
            5,                                  # output frame rate (5 fps for background video)
            (256, 256)                          # frame size (must match stored frames)
        )
        for j in frames:
            out.write(j)   # write each BGR frame to the video
        out.release()       # flush and close the video file

        logger.info(msg=f"Background frames added to video for Hour : {hour}")
    except Exception as e:
        logger.error(f"error occurred in updating background video frames : {e}")


# ══════════════════════════════════════════════════════════════════════════════
# generate_daily_background_images  —  every-5-min median background
# ══════════════════════════════════════════════════════════════════════════════

def generate_daily_background_images(timestamp, background_path, daily_frames, daily_frames_temp, current_frame, logger):
    """
    Compute and save the per-hour median background image every 5 minutes.

    Called every 5 minutes from a daemon thread.  Computes a pixel-wise
    median across the accumulated ``daily_frames`` to produce a static
    background model for the current hour.  The median suppresses transient
    foreground objects (people, vehicles) that appear in only a subset of
    frames.

    Frame selection priority
    ------------------------
    1. ``daily_frames`` has ≥ 30 entries → use daily_frames alone.
    2. ``daily_frames`` has < 30 entries AND ``daily_frames_temp`` is
       non-empty → combine: daily_frames + last N frames from
       daily_frames_temp to reach 30 total.
    3. ``daily_frames`` is empty AND ``daily_frames_temp`` is non-empty →
       use daily_frames_temp alone.
    4. No frames AND no existing background file for this hour → use
       current_frame as fallback (scene not yet populated enough).
    5. No frames AND background file already exists for this hour →
       skip (do nothing; the existing file is good enough).

    Output
    ------
    Saves ``<background_path>/daily_background_hour_<H>.jpg`` where
    ``H = timestamp.hour``.  Overwrites any existing file for that hour.

    Parameters
    ----------
    timestamp : datetime.datetime
        Current frame timestamp.  ``timestamp.hour`` identifies the hour slot.
    background_path : str
        Path to the camera's background directory.
    daily_frames : list[np.ndarray]
        Current hour's accumulated 256×256 BGR frames.
    daily_frames_temp : list[np.ndarray]
        Previous hour's frames (snapshot taken at the start of the current
        hour).  Used as a fallback when the current list is sparse.
    current_frame : np.ndarray
        The latest raw frame from the stream (any size).  Resized to 256×256
        internally.  Used as a last-resort fallback.
    logger : logging.Logger
        Shared frame-reader logger.
    """
    try:
        hour = timestamp.hour   # current hour slot (0–23)
        logger.info(msg=f">>>>>>>>>>>>>>>>>>>>>>>>>>>>Generating daily background images<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<")
        logger.info(msg=f"--------daily frames: {len(daily_frames)}---------")
        logger.info(msg=f"--------daily_frames_temp: {len(daily_frames_temp)}---------")

        median_frame = None   # will hold the computed background; stays None if no data available
        current_frame = cv2.resize(current_frame, (256, 256))   # normalise size for fallback

        if daily_frames:
            if len(daily_frames) < 30 and daily_frames_temp:
                # Not enough current frames → pad with tail of previous hour's frames
                # to get at least 30 frames for a reliable median
                combined_frames = daily_frames + daily_frames_temp[-(30 - len(daily_frames)):]
                median_frame = np.median(combined_frames, axis=0).astype(dtype=np.uint8)
                logger.info(msg=f"median frame uses daily frames and daily_frames_temp")
            else:
                # Sufficient current frames (≥30) OR no temp fallback available
                # → compute median from daily_frames only
                median_frame = np.median(daily_frames, axis=0).astype(dtype=np.uint8)
                logger.info(msg=f"median frame uses daily frames only")

        elif daily_frames_temp:
            # No current frames yet (very start of hour) — use previous hour's frames
            median_frame = np.median(daily_frames_temp, axis=0).astype(dtype=np.uint8)
            logger.info(msg=f"median frame uses daily_frames_temp only")

        elif not os.path.exists(f'{background_path}/daily_background_hour_{hour}.jpg'):
            # No frames at all AND no existing file for this hour
            # → use current frame as placeholder so the file always exists
            median_frame = current_frame
            logger.info(msg=f"median frame uses current_frame")
        # else: no frames but file already exists → median_frame stays None → skip write

        # Save the computed median frame as the daily background for this hour
        if median_frame is not None:
            cv2.imwrite(f'{background_path}/daily_background_hour_{hour}.jpg', median_frame)
            logger.info(msg=f"daily background image saved successfully!")

    except Exception as e:
        print(e)
        logger.info(msg=f"error occurred in generate_daily_background: {e}")


# ══════════════════════════════════════════════════════════════════════════════
# extract_frames  —  read all frames from a per-hour background MP4
# ══════════════════════════════════════════════════════════════════════════════

def extract_frames(background_path, hour, logger):
    """
    Read and return all frames from the per-hour background video file.

    Opens ``<background_path>/background_data_<hour>.mp4``, reads every
    frame into a list, releases the capture, and returns the list.  Returns
    an empty list (via the exception handler) if the video file does not
    exist or cannot be opened.

    Called by:
    - ``update_background_video_frames`` — to read existing frames before appending
    - ``generate_weekly_background``     — to read frames for the weekly median

    Parameters
    ----------
    background_path : str
        Path to the camera's background directory.
    hour : int
        Hour slot (0–23) identifying which video file to read.
    logger : logging.Logger
        Shared frame-reader logger.

    Returns
    -------
    list[np.ndarray]
        List of BGR frames (256×256).  Empty list if the video is missing
        or unreadable.
    """
    try:
        video = cv2.VideoCapture(f'{background_path}/background_data_{hour}.mp4')
        frames = []
        while video.isOpened():
            ret, frame = video.read()
            if not ret:
                break   # end of video or read error
            frames.append(frame)
        video.release()   # always release the capture handle
        return frames
    except Exception as e:
        logger.error(f"Error occurred in extracting frames from videos for hour- {hour}: {e}")


# ══════════════════════════════════════════════════════════════════════════════
# generate_weekly_background  —  midnight full rebuild from MP4 videos
# ══════════════════════════════════════════════════════════════════════════════

def generate_weekly_background(background_path, logger):
    """
    Rebuild the weekly background images for all 24 hours at midnight.

    Called once per day at ``timestamp.hour == 0 and timestamp.minute == 0``
    from a daemon thread.  For each hour slot (0–23), reads all frames from
    the corresponding ``background_data_<H>.mp4`` video and computes a
    pixel-wise median to produce a robust weekly background estimate.

    Why weekly in addition to daily?
    ---------------------------------
    The daily background (updated every 5 min) is sensitive to current-hour
    occupancy patterns.  The weekly background captures a full week's cycle
    of variation (e.g. empty at 02:00 every night, busy at 09:00 every
    morning) making it more robust for anomaly scoring.

    Output
    ------
    Saves ``<background_path>/weekly_background_hour_<H>.jpg`` for each
    hour slot that has at least one frame in its video.

    Per-hour errors (missing or corrupt video) are caught and logged
    individually so a single bad file does not abort the entire rebuild.

    Parameters
    ----------
    background_path : str
        Path to the camera's background directory.
    logger : logging.Logger
        Shared frame-reader logger.
    """
    for hour in range(24):   # process all 24 hourly slots
        try:
            # Extract all frames from this hour's accumulated background video
            frames = extract_frames(background_path=background_path, hour=hour, logger=logger)

            if frames:
                logger.info(msg=f"Total weekly frames from {hour} hour video : {len(frames)}")

                # Compute pixel-wise median → robust background ignoring transient objects
                weekly_bg = np.median(frames, axis=0).astype(dtype=np.uint8)
                cv2.imwrite(
                    background_path + f'/weekly_background_hour_{hour}.jpg',
                    weekly_bg
                )
                logger.info(msg=f"Weekly background image saved for Hour : {hour}")

        except Exception as e:
            # Log per-hour failure and continue — do not abort remaining hours
            logger.error(f"Error occurred in generating weekly background image for Hour : {hour} due to : {e}")
