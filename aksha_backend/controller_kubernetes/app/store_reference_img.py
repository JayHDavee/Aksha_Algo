import json, os
import logging
import cv2
import requests
from PIL import Image

OUTPUT_SIZE = (640, 360)
# WORK_DIR = 'Aksha'
DIR_TYPE = 'Reference_images'


def store_reference_image(frame, reference_img_path, rtsp_link):
    """
    to store reference image to reference_img_path (at "9:00:00")

    Args:
        frame (numpy.ndarray): current frame
        reference_img_path: path for saving reference images
    """        
    try:
        ref_img = cv2.resize(frame, OUTPUT_SIZE)
        cv2.imwrite(
            f"{reference_img_path}/{rtsp_link}.jpg", ref_img)
        print(f"Reference image stored at {reference_img_path}/{rtsp_link}.jpg")
        # print("Reference image stored !!!")

    except Exception as e:
        logging.error("Reference image storing error", e)


def store_no_image_on_failure(reference_img_path, rtsp_link):
    img = cv2.imread(f"{reference_img_path}/no-image-available-icon.png")
    cv2.imwrite(f"{reference_img_path}/{rtsp_link}.jpg", img)

def read_video(video_path):
    """
    function for capturing video from cameras using rtsp links

    Returns:
        capture object: cap
    """        
    vidcap = False
    try:
        if video_path.isnumeric():
            vidcap = cv2.VideoCapture(int(video_path))
            logging.info("video capture successfully")
        else:
            vidcap = cv2.VideoCapture(video_path)
            logging.info("video capture successfully")

    except Exception as e:
        logging.error("Error reading video path")
    return vidcap


def generate_reference_img(data: dict, dir_path: str):
    """Based on rtsplink data json file generate reference image for each rtsplink.
    
    Args:
        data: data dictionary containing rtsplink, camera name and unique ID's.
    """
    rtsp_links = list(data.keys())
    for rtsp_link in rtsp_links:
        vidcap = read_video(video_path=rtsp_link)
        reference_img_path = dir_path
        if vidcap == False:
            store_no_image_on_failure(reference_img_path, data[rtsp_link]['rtsp_id'])           
            logging.error(f"Error reading video path or missing dependent packages.")
        elif vidcap.isOpened():
            try:
                ret, frame = vidcap.read()
                if ret:
                    store_reference_image(frame, reference_img_path, data[rtsp_link]['rtsp_id'])

            except Exception as e:
                store_no_image_on_failure(reference_img_path, data[rtsp_link]['rtsp_id'])           
                print(msg=f"Reading frame issue {e}")
                # print(f"Reading frame issue {e}")
        else:
            store_no_image_on_failure(reference_img_path, data[rtsp_link]['rtsp_id'])           
            logging.error(f"Cannot open camera - {rtsp_link}")
            # print(f"Cannot open camera - {rtsp_link}")


def main(work_dir):
    with open(f"{work_dir}/rtsplinks.json", "r") as in_file:
        data = json.load(in_file)

    dir_path= f'{work_dir}/{DIR_TYPE}'
    dir_path_isexist = os.path.exists(dir_path)
    if not dir_path_isexist:
        os.makedirs(dir_path)
    
    url = 'https://aksha-storage.s3.ap-south-1.amazonaws.com/aksha-resources/no-image-available-icon.png'
    img = Image.open(requests.get(url, stream=True).raw)
    img.save(f'{dir_path}/no-image-available-icon.png')
    generate_reference_img(data, dir_path)

if __name__ == '__main__':
    main()
