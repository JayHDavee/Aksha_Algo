"""
utils.py  —  Per-Camera Directory Initialisation
=================================================

Architecture Overview
----------------------

    ┌──────────────────────────────────────────────────────────────────────┐
    │                  DIRECTORY LAYOUT PER CAMERA                         │
    │                                                                      │
    │  <AKSHA_PATH>/                                                       │
    │    <camera_name>/                                                    │
    │      frame/         raw JPEG frames (insight heatmap source)        │
    │      alerts/        annotated alert JPEG images                     │
    │      background/    anomaly background MP4 videos + JPEG images     │
    │      foreground/    foreground/motion model artefacts               │
    │      live/          current live view JPEGs (workday + holiday)     │
    │      spotlight/     current alert spotlight JPEGs                   │
    │      insight/       insight report outputs                          │
    │                                                                      │
    │  <AKSHA_PATH>/                                                       │
    │    Reference_images/   baseline reference JPEGs per RTSP stream     │
    │    insight_report/     global insight report outputs                │
    └──────────────────────────────────────────────────────────────────────┘

Calling convention
------------------
``dir_setup(camera_name)`` is the single public entry point.  It is called
once at service startup from ``main.py`` before ``read_frames`` starts.

Special handling for ``background/``
--------------------------------------
When the ``background`` directory does not yet exist, ``create_dir`` also
initialises 24 placeholder files for each hour slot (0–23):

  - ``daily_background_hour_<H>.jpg``    — 256×256 black placeholder
  - ``weekly_background_hour_<H>.jpg``   — 256×256 black placeholder
  - ``background_data_<H>.mp4``          — empty MP4 video (grayscale, 5 fps)

These placeholders ensure the anomaly model can always open a file for every
hour without crashing on first run before real background frames accumulate.
"""

# ── Standard library ──────────────────────────────────────────────────────────
import os        # path construction, makedirs, path existence checks
import logging   # module-level logger

# ── Third-party ───────────────────────────────────────────────────────────────
import numpy as np   # np.zeros for black placeholder images
import cv2           # imwrite, VideoWriter for background placeholder initialisation


# ── Module-level logger ───────────────────────────────────────────────────────
# Uses the root logger by default; frame_reader.py replaces this at runtime
# with its per-camera rotating logger via define_logger().
logger = logging.getLogger()

# Root data directory — all per-camera subdirectories are created beneath this
main_dir = os.getenv("AKSHA_PATH")


# ══════════════════════════════════════════════════════════════════════════════
# create_dir  —  create a single typed directory
# ══════════════════════════════════════════════════════════════════════════════

def create_dir(dir_type, update_camera_name):
    """
    Create one per-camera (or global) data directory and initialise its
    placeholder files if required.

    Accepted ``dir_type`` values
    ----------------------------
    Camera-scoped (created under ``<AKSHA_PATH>/<camera_name>/``):
      ``"frame"``        — raw JPEG frames for insight heatmap generation
      ``"alerts"``       — annotated alert JPEG images from post_processor
      ``"background"``   — anomaly model MP4 videos and background JPEGs
                           (special: also initialises 24-hour placeholder files)
      ``"foreground"``   — foreground/motion model artefacts
      ``"live"``         — current live-view JPEGs (workday.jpg, holiday.jpg)
      ``"spotlight"``    — current alert spotlight JPEGs
      ``"insight"``      — insight report output images

    Global (created directly under ``<AKSHA_PATH>/``):
      ``"Reference_images"`` — baseline reference JPEGs keyed by RTSP ID
      ``"insight_report"``   — global insight report outputs

    Parameters
    ----------
    dir_type : str
        One of the accepted directory type strings listed above.
    update_camera_name : str
        Camera identifier.  Used as the subdirectory name for camera-scoped
        types.  Ignored for global types (``Reference_images``, ``insight_report``).

    Returns
    -------
    str or None
        Full path to the created (or existing) directory.
        Returns ``None`` if ``dir_type`` is not recognised.
    """
    # ── Camera-scoped directories ─────────────────────────────────────────────
    if dir_type in ('insight', 'frame', 'alerts', 'background', 'foreground', 'live', 'spotlight'):

        if dir_type != 'background':
            # Standard camera subdirectory — create if not already present
            dir_path = os.path.join(main_dir, update_camera_name, dir_type)
            print(dir_path)
            dir_path_isexist = os.path.exists(dir_path)
            if not dir_path_isexist:
                os.makedirs(dir_path)
                logger.info(msg=f"{dir_path} created")
            else:
                logger.info(msg=f"{dir_path} already exist")
            return dir_path

        else:
            # ── Special case: background directory ───────────────────────────
            # On first creation, also initialise 24 placeholder files per hour
            # so the anomaly model never crashes on a missing file.
            background_path = os.path.join(main_dir, update_camera_name, 'background')
            print(background_path)
            background_isexist = os.path.exists(background_path)

            if not background_isexist:
                os.makedirs(background_path)

                # 256×256 black image — used as placeholder until real background
                # frames are accumulated by background_generator.py
                black = np.zeros((256, 256), dtype=np.uint8)   # grayscale black placeholder

                for hour in range(24):
                    # Placeholder daily and weekly background JPEGs for each hour slot
                    cv2.imwrite(f'{background_path}/weekly_background_hour_{hour}.jpg', black)
                    cv2.imwrite(f'{background_path}/daily_background_hour_{hour}.jpg', black)

                    # Empty MP4 video file for each hour slot.
                    # isColor=False because the placeholder frames are grayscale.
                    # The VideoWriter must be released immediately to flush the file header.
                    out = cv2.VideoWriter(
                        f'{background_path}/background_data_{hour}.mp4',
                        cv2.VideoWriter.fourcc(*'mp4v'),   # MP4V codec
                        5,                                  # 5 fps (matches background_generator)
                        (256, 256),                         # frame size
                        isColor=False                       # grayscale placeholder video
                    )
                    out.release()   # close immediately — just creates an empty valid video file

                logger.info(msg=f"Video file generated")
                logger.info(msg=f"{background_path} created and background images created")
            else:
                logger.info(msg=f"{background_path} already exist")

            return background_path

    # ── Global directories (shared across all cameras) ────────────────────────
    elif dir_type in ('Reference_images', 'insight_report'):
        # These directories live directly under AKSHA_PATH, not under a camera subfolder
        dir_path = os.path.join(main_dir, dir_type)
        dir_path_isexist = os.path.exists(dir_path)
        if not dir_path_isexist:
            os.makedirs(dir_path)
            logger.info(msg=f"{dir_path} created")
        else:
            logger.info(msg=f"{dir_path} already exist")
        return dir_path


# ══════════════════════════════════════════════════════════════════════════════
# dir_setup  —  create all required directories for one camera
# ══════════════════════════════════════════════════════════════════════════════

def dir_setup(camera_name):
    """
    Create (or verify) all required data directories for a camera at startup.

    Called once from ``main.py`` before ``read_frames`` starts.  Iterates
    over every directory type needed by the frame reader and downstream
    services, calling ``create_dir`` for each.

    Directory types created
    -----------------------
    Camera-scoped (under ``<AKSHA_PATH>/<camera_name>/``):
      ``frame``       — raw frames (insight heatmap)
      ``alerts``      — annotated alert images
      ``background``  — anomaly background model files
      ``foreground``  — foreground model artefacts
      ``spotlight``   — current alert spotlight images
      ``live``        — current live view images
      ``insight``     — insight report images

    Global (under ``<AKSHA_PATH>/``):
      ``Reference_images``  — RTSP reference baseline images
      ``insight_report``    — global insight report outputs

    Parameters
    ----------
    camera_name : str
        Camera identifier.  Used as the subdirectory name for all
        camera-scoped directories.
    """
    # Full set of directory types required by the frame reader and all
    # downstream services (post_processor, insight, anomaly model).
    dir_types = [
        "frame",            # raw JPEG frames for insight heatmap
        "alerts",           # annotated alert images from post_processor
        "background",       # anomaly model videos + JPEGs (24 hours × 3 files)
        "foreground",       # foreground/background model artefacts
        "spotlight",        # current alert spotlight image slots
        "Reference_images", # global RTSP reference baseline JPEGs
        "insight_report",   # global insight report output directory
        "live",             # current live view image slots (workday + holiday)
        "insight",          # per-camera insight images
    ]

    for dir_type in dir_types:
        create_dir(dir_type, camera_name)   # create each directory (idempotent)
