import cv2
import os
import glob
import logging
import output_video as ov

def create_video_from_frames(frames, work_dir, Camera_name, logger):
    try:

        frame_files = [f for f in frames if f.endswith(".jpg")]
        frame_files.sort()
        input_video_path= f'{work_dir}/{Camera_name}/insight/input_video_{Camera_name}.mp4'
        frame_rate = 40
        first_frame_path = os.path.join(frame_files[0])
        first_frame = cv2.imread(first_frame_path)
        # first_frame_resized = cv2.resize(first_frame, (256, 256))
        height, width, _ = first_frame.shape
        # print(height, width)
  
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        video_writer = cv2.VideoWriter(input_video_path, fourcc, frame_rate, (width, height))

        for frame_file in frame_files:

            frame_path = os.path.join(frame_file)
            frame = cv2.imread(frame_path)
            # frame_resized = cv2.resize(frame, (256, 256))
            video_writer.write(frame)

        video_writer.release()
        logger.info(msg='Input video created successfully')
        return input_video_path

    except Exception as e:
        logger.error(msg=f'Exception in create_input_video.py: {e}')
        raise
