"""
output_video — MOG background subtraction heatmap generator.

Used by insight.create_heatmap() as Step 4 of the heatmap pipeline.

Algorithm per frame:
  1. Apply MOG background subtractor → foreground mask
  2. Threshold mask (value 2 → 12) to remove noise
  3. Accumulate thresholded mask into accum_image (uint8, wraps at 255)
  4. Apply COLORMAP_HOT to accum_image → colour heat overlay
  5. Blend overlay 70/70 with original frame → heatmap frame JPEG

Outputs:
  {insight_path}/heatmap_video_{cam}.mp4   — full annotated video (ffmpeg, libx264)
  {insight_path}/heatmap_img_{cam}.jpg     — final accumulated heatmap still
"""

import numpy as np
import os
import cv2
import copy
import logging
import ffmpeg


def heatmap_video(input_video_path, work_dir, Camera_name, logger):
    """
    Run the MOG heatmap algorithm over *input_video_path* and write the result video.

    Returns the path to the generated heatmap MP4.

    Why addWeighted(0.7, 0.7): both weights intentionally exceed 0.5 to brighten
    the overlay — the sum > 1.0 saturates highlights, making hot zones more visible.
    """
    try:
        capture              = cv2.VideoCapture(input_video_path)
        background_subtractor = cv2.bgsegm.createBackgroundSubtractorMOG()
        length               = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))

        insight_path = f'{work_dir}/{Camera_name}/insight'
        os.makedirs(f'{insight_path}/heatmap/frames/', exist_ok=True)

        first_iteration = True
        accum_image     = None
        first_frame     = None

        for i in range(length):
            ret, frame = capture.read()
            if not ret:
                break

            if first_iteration:
                # Store the first frame as the background base for the final still overlay
                first_frame     = copy.deepcopy(frame)
                height, width   = frame.shape[:2]
                accum_image     = np.zeros((height, width), np.uint8)
                first_iteration = False
                continue

            # Remove static background — returns a foreground mask
            fg_mask = background_subtractor.apply(frame)

            # Threshold to remove low-confidence noise pixels
            threshold, maxValue = 2, 12
            _, th1 = cv2.threshold(fg_mask, threshold, maxValue, cv2.THRESH_BINARY)

            # Accumulate motion — brighter pixels = more motion over time
            accum_image = cv2.add(accum_image, th1)

            # Apply hot colour map and blend with the current frame
            color_overlay = cv2.applyColorMap(accum_image, cv2.COLORMAP_HOT)
            video_frame   = cv2.addWeighted(frame, 0.7, color_overlay, 0.7, 0)

            # Save individual heatmap frames for ffmpeg to stitch into video
            cv2.imwrite(f'{insight_path}/heatmap/frames/frame{i}.jpg', video_frame)

        capture.release()

        # Count how many heatmap frames were actually written to disk.
        # The first video frame (i=0) is always skipped (used as background
        # baseline), so the sequence on disk starts at frame1.jpg.
        # If no frames were written (e.g. single-frame input), abort early.
        frames_written = len(os.listdir(f'{insight_path}/heatmap/frames/'))
        if frames_written == 0:
            logger.error(f"No heatmap frames written — input video too short | camera={Camera_name}")
            raise RuntimeError("No heatmap frames written — input video must have at least 2 frames")

        # Encode saved frames into a compressed MP4 via ffmpeg.
        # start_number=1 is required because frame0.jpg is never written
        # (the first iteration is skipped to initialise the background model).
        # Without it ffmpeg looks for frame0.jpg, fails to open it, and aborts.
        # capture_stderr=True surfaces the actual ffmpeg error message in the
        # exception instead of the opaque "see stderr output for detail".
        heatmap_vid_path = f'{insight_path}/heatmap_video_{Camera_name}.mp4'
        try:
            out, err = (
                ffmpeg
                .input(f'{insight_path}/heatmap/frames/frame%d.jpg',
                       framerate=30, start_number=1)
                .output(heatmap_vid_path, vcodec='libx264', pix_fmt='yuv420p', movflags='faststart')
                .run(overwrite_output=True, capture_stdout=True, capture_stderr=True)
            )
        except ffmpeg.Error as e:
            # Decode and log the actual ffmpeg stderr so the root cause is visible
            stderr_text = e.stderr.decode('utf-8', errors='replace') if e.stderr else 'no stderr'
            logger.error(f"ffmpeg failed | camera={Camera_name} | stderr={stderr_text}")
            raise

        # Write the final accumulated heatmap still over the first frame
        color_image    = cv2.applyColorMap(accum_image, cv2.COLORMAP_HOT)
        result_overlay = cv2.addWeighted(first_frame, 0.7, color_image, 0.7, 0)
        cv2.imwrite(f'{insight_path}/heatmap_img_{Camera_name}.jpg', result_overlay)

        # Remove per-frame JPEGs — the MP4 and still are the only outputs needed
        for file in os.listdir(f'{insight_path}/heatmap/frames/'):
            os.remove(f'{insight_path}/heatmap/frames/{file}')

        logger.info(f"Heatmap video saved | path={heatmap_vid_path}")
        return heatmap_vid_path

    except Exception as e:
        logger.error(f"Exception in output_video.heatmap_video: {e}")
        raise
