
import numpy as np
import os
import cv2
import copy
import logging
import ffmpeg


def heatmap_video(input_video_path, work_dir, Camera_name, logger):
    try:

        capture = cv2.VideoCapture(f"{input_video_path}")
        background_subtractor = cv2.bgsegm.createBackgroundSubtractorMOG()
        length = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))

        insight_path= f'{work_dir}/{Camera_name}/insight'

        if not os.path.exists(f'{insight_path}/heatmap/frames/'):
            os.makedirs(f'{insight_path}/heatmap/frames/')

        first_iteration_indicator = 1
        for i in range(0, length):

            ret, frame = capture.read()

            # If first frame
            if first_iteration_indicator == 1:

                first_frame = copy.deepcopy(frame)
                height, width = frame.shape[:2]
                accum_image = np.zeros((height, width), np.uint8)
                first_iteration_indicator = 0
            else:

                filter = background_subtractor.apply(frame)  # remove the background
                cv2.imwrite(f'{insight_path}/heatmap/frame.jpg', frame)
                cv2.imwrite(f'{insight_path}/heatmap/diff-bkgnd-frame.jpg', filter)

                threshold = 2
                maxValue = 12
                ret, th1 = cv2.threshold(filter, threshold, maxValue, cv2.THRESH_BINARY)

                # add to the accumulated image
                accum_image = cv2.add(accum_image, th1)
                cv2.imwrite(f'{insight_path}/heatmap/mask.jpg', accum_image)

                color_image_video = cv2.applyColorMap(accum_image, cv2.COLORMAP_HOT)

                video_frame = cv2.addWeighted(frame, 0.7, color_image_video, 0.7, 0)

                name = f'{insight_path}/heatmap/frames/frame%d.jpg' % i
                cv2.imwrite(name, video_frame)

        heatmap_vid_path= f'{insight_path}/heatmap_video_{Camera_name}.mp4'    
        # make_video(f'{insight_path}/heatmap/frames/', heatmap_vid_path , work_dir)

        (
            ffmpeg
            .input(f'{insight_path}/heatmap/frames/frame%d.jpg', framerate=30)
            .output(heatmap_vid_path, vcodec='libx264', pix_fmt='yuv420p', movflags='faststart', loglevel="quiet")
            .run(overwrite_output=True)
        )

        color_image = cv2.applyColorMap(accum_image, cv2.COLORMAP_HOT)
        result_overlay = cv2.addWeighted(first_frame, 0.7, color_image, 0.7, 0)

        # save the final heatmap
        
        cv2.imwrite(f'{insight_path}/heatmap_img_{Camera_name}.jpg', result_overlay)
        # cleanup
        capture.release()
        logger.info(msg=f"Heatmap video saved successfully at {heatmap_vid_path}")

        # delete frames used to make heatmap video

        for file in os.listdir(f'{insight_path}/heatmap/frames/'):
            os.remove(f'{insight_path}/heatmap/frames/' + file)
        return heatmap_vid_path
    except Exception as e:
        logger.info(msg=f'Following exception occured in output_video.py: {e}')
