"""
image_analysis — Azure GPT vision Q&A and chat-log download helpers.

Pipeline (imageanalysis):
  base64 image (or SVG data URL)
    → convert_svgb64_to_jpgb64()   SVG → PNG → JPEG in memory (if needed)
    → create_prompt()               embed question + chat history
    → get_image_answer()            call Azure GPT with image_url + text prompt
    → JSON response {"answer", "message"}

Pipeline (download_image_analysis_chat_logs):
  base64 image + chat history
    → save_data_to_zip()            pack chat_logs.txt + chat_image.jpg into a BytesIO ZIP
    → StreamingResponse             returned to frontend as application/zip download

Azure models supported: GPT 4o, GPT 4 Turbo (configured via .env)
"""

import logging
import os
from openai import AzureOpenAI
from dotenv import load_dotenv
import json
import base64
import time
import cairosvg
from io import BytesIO
from PIL import Image
from zipfile import ZipFile
from datetime import datetime
import sys

exe_file = sys.executable
exe_parent = os.path.dirname(exe_file)
dotenv_path = os.path.join(exe_parent, ".env")
load_dotenv(dotenv_path=dotenv_path)


def imageanalysis(question, image, model_option, chat_history):
    """
    Entry point — answer *question* about *image* using the selected Azure GPT model.

    Args:
      image:        data URL (base64 JPEG or SVG+XML); SVG is converted to JPEG before sending
      model_option: "GPT 4o" or "GPT 4 Turbo"
      chat_history: list of prior Q&A pairs, or None for a fresh conversation

    Returns:
      (result_json, mimetype, status_code)
        result_json — {"answer": str, "message": "success"|"failed ..."}
    """
    # Convert SVG data URLs to JPEG — Azure GPT vision does not accept SVG
    if image.startswith('data:image/svg+xml;base64,'):
        image = convert_svgb64_to_jpgb64(image)
    try:
        model_response = get_image_answer(
            user_question=question, base64_image=image,
            model_option=model_option, chat_history=chat_history
        )
        result = json.dumps({'answer': str(model_response), 'message': 'success'})
        return result, "application/json", 200
    except Exception as e:
        logging.error(f'Exception in imageanalysis: {e}')
        result = json.dumps({'answer': "", 'message': f'failed {e}'})
        return result, "application/json", 400


def get_image_answer(user_question, base64_image, model_option, chat_history):
    """
    Build the chat prompt and call Azure GPT with the image attached.

    Returns the model's text response string.
    max_tokens=4096 — sufficient for most 3-line factual answers about camera frames.
    """
    model_dict = {
        "GPT 4o":      os.getenv("AZURE_DEPLOYMENT_GPT_4o"),
        "GPT 4 Turbo": os.getenv("AZURE_DEPLOYMENT_GPT_4_TURBO"),
    }
    azure_openai = AzureOpenAI(
        api_key=os.getenv("AZURE_OPENAI_API_KEY"),
        api_version=os.getenv("AZURE_API_VERSION"),
        azure_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT")
    )

    deployment_name = model_dict[model_option]
    logging.info(f"ImageAnalysis: calling Azure GPT | model={deployment_name}")

    prompt = create_prompt(user_question, chat_history)

    start = time.time()
    response = azure_openai.chat.completions.create(
        model=deployment_name,
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"{base64_image}"}},
            ],
        }],
        max_tokens=4096
    )
    elapsed = time.time() - start
    logging.info(f"ImageAnalysis: response received | elapsed={elapsed:.1f}s | model={deployment_name}")

    return response.choices[0].message.content


def create_prompt(user_question, chat_history):
    """
    Build the system prompt embedding *user_question* and optional *chat_history*.

    Two variants:
      - with chat history: model is reminded of prior exchanges for follow-up questions
      - without: clean single-turn question against the image
    """
    if chat_history is not None:
        prompt = f"""
Answer the following question in no more than 3 lines, based on the given image and previous chat history for the image:
user question: {user_question}
chat history: {chat_history}
Keep the following in mind:
- If a blue polygon is drawn over the image, its an area of interest. Object detection alerts have a bounding box and label in their respective colors.
- Never mention the previous chat history or any of the context provided to you in your response
- Analyze the image carefully before answering. If unsure about something in the image, simply state you can't answer. Don't invent new details.
- If asked questions unrelated to the image, just state that you cant answer this question.
"""
    else:
        prompt = f"""
Answer the following question in no more than 3 lines, based on the given image:
user question: {user_question}
Keep the following in mind:
- If a blue polygon is drawn over the image, its an area of interest. Object detection alerts have a bounding box and label in their respective colors.
- Never mention the previous chat history or any of the context provided to you in your response
- Analyze the image carefully before answering. If unsure about something in the image, simply state you can't answer. Don't invent new details.
- If asked questions unrelated to the image, just state that you cant answer this question.
"""
    return prompt


def convert_svgb64_to_jpgb64(svgstr):
    """
    Convert a SVG data URL to a JPEG base64 data URL in memory.

    Uses CairoSVG for SVG→PNG, then Pillow for PNG→JPEG.
    Alpha channel is dropped (JPEG does not support transparency).
    """
    # Render SVG to PNG bytes via CairoSVG
    png_data = cairosvg.svg2png(url=svgstr)
    with Image.open(BytesIO(png_data)) as img:
        # Drop alpha channel — JPEG does not support transparency
        img = img.convert("RGB")
        jpg_buffer = BytesIO()
        img.save(jpg_buffer, format="JPEG", quality=100, optimize=True)
        jpg_buffer.seek(0)
    jpg_base64 = base64.b64encode(jpg_buffer.read()).decode('utf-8')
    return f"data:image/jpg;base64,{jpg_base64}"


def download_image_analysis_chat_logs(b64img, chat_history):
    """
    Package *b64img* and *chat_history* into an in-memory ZIP and return it for download.

    Returns:
      (zip_buffer, headers, status_code)
        zip_buffer — BytesIO containing chat_logs.txt + chat_image.jpg
        headers    — Content-Disposition + CORS headers for StreamingResponse
    """
    try:
        zip_buffer = save_data_to_zip(b64img, chat_history)
        current_date = datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
        zipfile_name = f"chat_log_{current_date}"
        headers = {
            'Content-Disposition':          f'attachment; filename="{zipfile_name}.zip"',
            'Access-Control-Expose-Headers': 'Content-Disposition',
            'Access-Control-Allow-Origin':   '"*"',
        }
        logging.info(f"Chat log ZIP prepared | filename={zipfile_name}.zip")
        return zip_buffer, headers, 200
    except Exception as e:
        logging.error(f'Exception in download_image_analysis_chat_logs: {e}')
        return f"An error occurred: {str(e)}", None, 400


def save_data_to_zip(image, chat_history):
    """
    Write *image* (JPEG) and *chat_history* (JSON) into a BytesIO ZIP archive.

    SVG images are converted to JPEG first so the archive always contains a viewable image.
    Returns the seeked-to-start BytesIO buffer.
    """
    if image.startswith('data:image/svg+xml;base64,'):
        image = convert_svgb64_to_jpgb64(image)

    # Strip the data URL prefix to get raw base64
    b64img = image.split(',')[-1]
    image_data = base64.b64decode(b64img)
    text_data = json.dumps(chat_history, indent=4)

    zip_buffer = BytesIO()
    with ZipFile(zip_buffer, 'w') as zip_object:
        zip_object.writestr('chat_logs.txt',  text_data)
        zip_object.writestr('chat_image.jpg', image_data)
    zip_buffer.seek(0)
    logging.info("ZIP buffer created successfully")
    return zip_buffer
