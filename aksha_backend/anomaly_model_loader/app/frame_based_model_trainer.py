"""
frame_based_model_trainer  –  Per-Hour IsolationForest Training
===============================================================

Role
----
This module trains a separate anomaly-detection model for each hour of the
day, using the foreground (background-subtracted) images captured by a single
camera during that hour over the past N days.  The resulting models are
consumed by the anomaly_model_loader service to score incoming frames in
near-real-time.

Architecture
------------
Training is driven entirely by files on disk.  No database connection is
required.  The data flow is::

    Disk (foreground images)
    ├── <AKSHA_PATH>/<camera>/foreground/<date>/<hour>/
    │       frame_HHMMSS_001.png
    │       frame_HHMMSS_002.png
    │       ...
    │
    ▼
    get_training_frames()                  Collect sorted file paths for the
    │                                      target hour over the last n_days days
    ▼
    train_isolation_forest_model()
    │
    ├── Load each image in grayscale
    ├── Resize to 256 × 256 pixels
    ├── Filter: black frames (MSE == 0 vs all-zero reference)
    ├── Filter: near-duplicate consecutive frames (SSIM > 0.90 threshold)
    ├── Flatten each frame to a 1-D vector of length 256 × 256 = 65 536
    ├── Fit IsolationForest(contamination=anomaly_percent)
    │
    ▼
    Disk (saved model)
    └── <AKSHA_PATH>/<camera>/anomaly_models/framebase/<hour>.pkl

Training data window
--------------------
For each call to ``train_isolation_forest_model`` the function collects frames
from the **same clock hour** across the **previous 7 calendar days**
(``n_days=7``).  This gives the model a weekly temporal context, capturing
both normal variation (lighting changes, crowd patterns) and the fact that
activity at 08:00 on a Monday differs from 08:00 on a Saturday.

Model output
------------
Each trained ``IsolationForest`` object is serialised with ``pickle`` and
written to::

    <AKSHA_PATH>/<camera>/anomaly_models/framebase/<hour>.pkl

The model loader re-reads this file at the start of every new hour so that
the active model always matches the expected background distribution for the
current time slot.

``contamination`` parameter
---------------------------
``anomaly_percent`` (default 0.005, i.e. 0.5 %) is passed directly to
``IsolationForest(contamination=...)`` and represents the expected fraction of
anomalous samples in the training corpus.  Because foreground images are
captured during normal operation the vast majority are "normal", so 0.5 %
is a deliberately conservative value that makes the model sensitive to
genuine deviations without generating excessive false positives.

Environment variables used at module level
------------------------------------------
CAMERA_NAME  : Camera identifier for log-file path construction.
AKSHA_PATH   : Root directory under which per-camera subdirectories live.
"""

import os
import numpy as np
from datetime import date
from datetime import timedelta
from sklearn.ensemble import IsolationForest
import pickle
import cv2
from skimage.metrics import mean_squared_error
from skimage.metrics import structural_similarity
import logging

# ── Module-level configuration from environment ───────────────────────────────
# These are read once when the module is imported.  train_isolation_forest_model
# accepts explicit aksha_path / camera_name arguments so it can be called from
# other modules with overrides; the env-var values are used only for logging.
camera_name = os.getenv("CAMERA_NAME")
main_dir = os.getenv("AKSHA_PATH")

# Build the log directory path and ensure it exists before configuring the
# file handler (basicConfig raises if the directory is missing).
logger_path = f"{main_dir}/{camera_name}/log"
os.makedirs(logger_path, exist_ok=True)

logging.basicConfig(
    filename=f"{logger_path}/model_loader.log",
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    filemode="a",
)
logger = logging.getLogger("model_loader")


# ── Training data collection ──────────────────────────────────────────────────

def get_training_frames(aksha_path, start_hour, n_days, camera_name):
    """Collect sorted foreground-image file paths for a specific clock hour.

    Walks backward through the most recent ``n_days`` calendar days (starting
    from *yesterday*, so the current incomplete day is excluded) and, for each
    day, lists every file inside::

        <aksha_path>/<camera_name>/foreground/<date>/<start_hour>/

    Files within each directory are sorted lexicographically (which preserves
    chronological order when filenames embed timestamps) and appended to a flat
    list.  Directories that do not exist are silently skipped with an INFO log
    line so missing data for a single day does not abort the collection.

    Parameters
    ----------
    aksha_path : str
        Root filesystem path where all camera data is stored.
    start_hour : int
        Clock hour (0–23) to collect frames for.  Only the subdirectory
        matching this integer is searched inside each date folder.
    n_days : int
        Number of days to look back, **not counting today**.  The loop
        iterates ``n_days + 1`` times (range ``0`` … ``n_days`` inclusive),
        so passing ``7`` collects data from yesterday back through 7 days ago
        (8 iterations total, but the loop body is identical for each offset).
    camera_name : str
        Camera identifier used as the second path component.

    Returns
    -------
    list[str]
        Flat, ordered list of absolute file paths.  The list is ordered
        by day (most recent first) and by sorted filename within each day.
        Returns an empty list if no matching directories are found.
    """
    frames_list = []  # Accumulator for absolute file paths across all days

    # Start from yesterday so the partially-populated current day is excluded
    current_date = date.today() - timedelta(days=1)

    # Iterate from diff=0 (yesterday) through diff=n_days (n_days ago)
    for diff in range(n_days + 1):
        # Compute the calendar date for this iteration
        target_date = current_date - timedelta(days=diff)

        # Construct the full path to the hour-specific foreground subdirectory
        search_path = os.path.join(aksha_path, camera_name, "foreground", str(target_date), str(start_hour))
        logger.info(f"[FRAMEBASE] Checking path: {search_path}")

        # Skip gracefully if the directory does not exist (e.g. camera was
        # offline on that day or data has already been purged).
        if not os.path.exists(search_path):
            logger.info(f"[FRAMEBASE] ❌ Path NOT found")
            continue

        try:
            files = os.listdir(search_path)
            logger.info(f"[FRAMEBASE] ✅ Path found, files = {len(files)}")
        except Exception as e:
            # Log the error and continue; a single unreadable directory should
            # not prevent training from the remaining days.
            logger.exception(f"[FRAMEBASE] Failed to list files in {search_path}: {e}")
            continue

        # Sort file names so frames are processed in chronological order within
        # each hour-directory; then prepend the full directory path.
        frames = sorted(os.path.join(search_path, f) for f in files)
        frames_list.extend(frames)

    logger.info(f"[FRAMEBASE] Total frames collected = {len(frames_list)}")
    return frames_list


# ── Model training ────────────────────────────────────────────────────────────

def train_isolation_forest_model(aksha_path, camera_name, anomaly_percent, start_hour):
    """Train an IsolationForest model on foreground frames for a given hour.

    Performs the full training pipeline: data collection, frame-level quality
    filtering, feature extraction, model fitting, and model serialisation.

    Pipeline steps
    --------------
    1. **Data collection**
       Calls ``get_training_frames`` with ``n_days=7`` to gather up to 8 days
       (7 past days + the day before today) of foreground images captured
       during ``start_hour``.

    2. **Image loading and resizing**
       Each file is read with ``cv2.imread(path, 0)`` (grayscale, single
       channel).  Invalid / unreadable files (``image is None``) are skipped.
       Every valid image is resized to a fixed **256 × 256** pixel grid so all
       feature vectors have the same dimension regardless of camera resolution.

    3. **Black-frame filter**
       A reference ``black_frame`` (all-zero 256 × 256 array) is compared to
       each resized image using ``mean_squared_error``.  If MSE == 0.0 the
       image is identical to the black reference (completely dark foreground –
       no motion or night-time dropout) and is discarded.

    4. **SSIM near-duplicate filter**
       Consecutive retained frames are compared with
       ``structural_similarity(prev, curr, ...)`` after normalising pixel
       values to [0, 1].  If the SSIM score exceeds **0.90** (frames are
       more than 90 % structurally similar) the current frame is skipped and
       ``previous_frame`` is updated to it so the next comparison uses the
       most recent seen frame.  This removes redundant frames from slow-moving
       scenes and reduces training time without losing diversity.

    5. **Feature extraction**
       Each remaining 256 × 256 frame is flattened to a 1-D vector of length
       ``256 * 256 = 65 536`` using ``image.flatten()``.  All vectors are
       accumulated row-wise into ``image_array`` (shape ``[N, 65536]``,
       dtype ``uint8``).

    6. **Model fitting**
       An ``IsolationForest(contamination=anomaly_percent)`` is instantiated
       and fitted on ``image_array``.  ``contamination`` tells the algorithm
       the expected fraction of anomalous samples; 0.005 = 0.5 % (see module
       docstring for rationale).

    7. **Model serialisation**
       The fitted model is written to::

           <aksha_path>/<camera_name>/anomaly_models/framebase/<start_hour>.pkl

       using ``pickle.dump``.  The directory is created if it does not exist.
       The file name is the bare hour integer so the loader can find it with
       ``f"{hour}.pkl"`` without any additional metadata.

    Parameters
    ----------
    aksha_path : str
        Root filesystem path where all camera data is stored.
    camera_name : str
        Camera identifier used as the second path component.
    anomaly_percent : float
        IsolationForest ``contamination`` parameter.  Expected fraction of
        anomalous samples in the training set (e.g. 0.005 for 0.5 %).
    start_hour : int
        Clock hour (0–23) for which the model is being trained.  Determines
        which foreground subdirectory is read and what the output file is named.

    Raises
    ------
    RuntimeError
        If no frames are found at all (before filtering) or if no valid frames
        remain after the black-frame and SSIM filters.  These are re-raised
        after logging so the caller (``scheduled_reports`` or the REST endpoint)
        can decide how to handle the failure.
    Exception
        Any other unexpected exception is logged via ``logger.exception`` and
        then re-raised to prevent silent failures.
    """
    try:
        # ── Step 1: collect raw file paths ───────────────────────────────────
        training_frames = get_training_frames(
            aksha_path=aksha_path,
            start_hour=start_hour,
            n_days=7,          # Train on the past 7 days of the same hour
            camera_name=camera_name
        )

        # Hard stop: cannot train without any source images
        if len(training_frames) == 0:
            logger.error("No frame detected for training")
            raise RuntimeError("No frame detected for training")

        # ── Step 2: pre-allocate the feature matrix ───────────────────────────
        # Shape: (0, 65536).  We grow it row-by-row using np.append; while not
        # the most memory-efficient approach, it avoids a two-pass loop.
        image_array = np.empty((0, 256 * 256), dtype=np.uint8)

        # Reference image used for black-frame detection: all pixels are zero
        black_frame = np.zeros((256, 256), np.uint8)

        # SSIM filter state variables
        previous_frame_status = False   # False until the first valid frame is seen
        previous_frame = None           # Holds the last accepted (non-duplicate) frame

        # ── Steps 3–5: load, filter, and flatten each frame ──────────────────
        for image_filename in training_frames:
            # Load as grayscale (flag 0 = cv2.IMREAD_GRAYSCALE)
            image = cv2.imread(image_filename, 0)
            if image is None:
                # Unreadable or corrupt file; skip without aborting the loop
                logger.info(f"Skipping invalid image: {image_filename}")
                continue

            # Standardise spatial resolution to 256 × 256 for a fixed feature length
            image = cv2.resize(image, (256, 256))

            # ── Black-frame filter ────────────────────────────────────────────
            # MSE == 0 means every pixel in the resized image equals the
            # corresponding pixel in black_frame (all zero), i.e. the frame
            # carries no visual information.  Discard it.
            if mean_squared_error(black_frame, image) == 0.0:
                continue

            # ── SSIM near-duplicate filter ────────────────────────────────────
            if previous_frame_status:
                # Compare the current frame against the last accepted frame.
                # Normalise to [0, 1] range (divide by 255) before SSIM so the
                # data_range=1 parameter is consistent.
                ssim, _ = structural_similarity(
                    previous_frame.astype(np.float32) / 255,
                    image.astype(np.float32) / 255,
                    full=True,
                    channel_axis=None,   # Single-channel (grayscale) image
                    data_range=1         # Values are in [0, 1] after normalisation
                )
                if ssim > 0.90:
                    # Frame is too similar to its predecessor; advance the
                    # reference pointer but exclude this frame from training.
                    previous_frame = image
                    continue
            else:
                # First valid non-black frame; enable the SSIM check from here on
                previous_frame_status = True

            # Frame passed both filters; update the rolling reference
            previous_frame = image

            # Flatten 256 × 256 → 65 536-element row vector and append to matrix
            image_array = np.append(
                image_array,
                np.expand_dims(image.flatten(), axis=0),  # shape (1, 65536)
                axis=0
            )

        # ── Step 6: train IsolationForest ─────────────────────────────────────
        if image_array.shape[0] == 0:
            # All frames were filtered out (all black or all near-identical)
            logger.error("No valid frames after filtering")
            raise RuntimeError("No valid frames after filtering")

        # contamination = expected fraction of outliers in the training set.
        # anomaly_percent = 0.005 means 0.5 % of training frames are expected
        # to be anomalous, making the decision boundary tight around normality.
        clf = IsolationForest(contamination=anomaly_percent)
        clf.fit(image_array)  # Fit on the N × 65536 feature matrix

        # ── Step 7: serialise model to disk ───────────────────────────────────
        # Ensure the target directory exists (it may not on a fresh deployment)
        dir_path = f"{aksha_path}/{camera_name}/anomaly_models/framebase"
        os.makedirs(dir_path, exist_ok=True)

        # File name is the bare hour integer so the loader can find it by
        # constructing f"{hour}.pkl" without additional metadata.
        file_path = os.path.join(dir_path, f"{start_hour}.pkl")
        with open(file_path, "wb") as f:
            pickle.dump(clf, f)
        logger.info(f"Model saved successfully at {file_path}")

    except Exception as e:
        # Log the full traceback (exception() includes it) then re-raise so
        # callers can react appropriately (e.g. skip this hour's update).
        logger.exception(f"Failed to train isolation forest model: {e}")
        raise
