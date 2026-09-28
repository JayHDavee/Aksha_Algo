"""
store_reference_img — capture and store one reference JPEG per camera from its RTSP stream.

Used at container start (called via main()) or on-demand to refresh reference images.
Reference images serve as the static background baseline for anomaly detection and
background subtraction in other services.

Output directory: {AKSHA_PATH}/Reference_images/{rtsp_id}.jpg
"""

import json
import os
import logging
import cv2
import requests
from PIL import Image

OUTPUT_SIZE = (640, 360)   # resize all reference images to this resolution before saving
DIR_TYPE    = 'Reference_images'


def store_reference_image(frame, reference_img_path, rtsp_link):
    """
    Resize *frame* to OUTPUT_SIZE and write it to {reference_img_path}/{rtsp_link}.jpg.

    Called when a valid frame was successfully captured from the RTSP stream.
    """
    try:
        ref_img = cv2.resize(frame, OUTPUT_SIZE)
        cv2.imwrite(f"{reference_img_path}/{rtsp_link}.jpg", ref_img)
        logging.info(f"Reference image stored | path={reference_img_path}/{rtsp_link}.jpg")
    except Exception as e:
        logging.error(f"Reference image storing error: {e}")


def store_no_image_on_failure(reference_img_path, rtsp_link):
    """
    Write the 'no image available' placeholder when the RTSP stream cannot be opened.

    Ensures downstream services always find a file at the expected path even if
    the camera is unreachable at startup.
    """
    img = cv2.imread(f"{reference_img_path}/no-image-available-icon.png")
    cv2.imwrite(f"{reference_img_path}/{rtsp_link}.jpg", img)
    logging.warning(f"Stored no-image placeholder | rtsp_link={rtsp_link}")


def read_video(video_path):
    """
    Open *video_path* with cv2.VideoCapture (numeric string → integer device index).

    Returns the VideoCapture object, or False on failure.
    """
    vidcap = False
    try:
        if video_path.isnumeric():
            vidcap = cv2.VideoCapture(int(video_path))
        else:
            vidcap = cv2.VideoCapture(video_path)
        logging.info(f"Video capture opened | path={video_path}")
    except Exception as e:
        logging.error(f"Error reading video path {video_path}: {e}")
    return vidcap


def generate_reference_img(data: dict, dir_path: str):
    """
    Capture one reference frame per RTSP link in *data* and save it to *dir_path*.

    Falls back to the no-image placeholder if the stream is unreachable or unreadable.
    *data* is the rtsplinks.json dict: {rtsp_url: {rtsp_id, cam_name, ...}}.
    """
    for rtsp_link, cam_info in data.items():
        rtsp_id = cam_info['rtsp_id']
        vidcap  = read_video(video_path=rtsp_link)
        if vidcap is False:
            store_no_image_on_failure(dir_path, rtsp_id)
            logging.error(f"Could not open video capture | rtsp_link={rtsp_link}")
        elif vidcap.isOpened():
            try:
                ret, frame = vidcap.read()
                if ret:
                    store_reference_image(frame, dir_path, rtsp_id)
                else:
                    store_no_image_on_failure(dir_path, rtsp_id)
                    logging.warning(f"Empty frame read | rtsp_link={rtsp_link}")
            except Exception as e:
                store_no_image_on_failure(dir_path, rtsp_id)
                logging.error(f"Frame read error | rtsp_link={rtsp_link}: {e}")
        else:
            store_no_image_on_failure(dir_path, rtsp_id)
            logging.error(f"Cannot open camera | rtsp_link={rtsp_link}")


def main(work_dir):
    """
    CLI entry point — read rtsplinks.json, download the placeholder image, then
    generate reference images for all registered cameras.
    """
    with open(f"{work_dir}/rtsplinks.json", "r") as in_file:
        data = json.load(in_file)

    dir_path = f'{work_dir}/{DIR_TYPE}'
    os.makedirs(dir_path, exist_ok=True)

    # Download the shared no-image placeholder from S3 so it is available for fallbacks
    url = 'https://aksha-storage.s3.ap-south-1.amazonaws.com/aksha-resources/no-image-available-icon.png'
    img = Image.open(requests.get(url, stream=True).raw)
    img.save(f'{dir_path}/no-image-available-icon.png')
    logging.info("Downloaded no-image placeholder")

    generate_reference_img(data, dir_path)


if __name__ == '__main__':
    main()
