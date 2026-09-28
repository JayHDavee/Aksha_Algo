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

#------ Function API to receive request body and response with model answer ------
def imageanalysis(question, image, model_option, chat_history):
    if image.startswith('data:image/svg+xml;base64,'):
       image= convert_svgb64_to_jpgb64(image)
    try:
        model_response= get_image_answer(user_question=question, base64_image=image, model_option=model_option, chat_history=chat_history)
        result= json.dumps({'answer': str(model_response), 'message': 'success'})
        mimetype = "application/json"
        status_code=200
        return result, mimetype , status_code
    
    except Exception as e:
       logging.info(msg=f'Following exception occured in Image Analysis Function: {e}')
       result= json.dumps({'answer': "", 'message': f'failed {e}'})
       mimetype = "application/json"
       status_code=400
       return result, mimetype,status_code

#------ Function to get user input and call the OpenAI GPT model of choice for answering user question ------   
def get_image_answer(user_question, base64_image, model_option, chat_history):
    model_dict={
       "GPT 4o": os.getenv("AZURE_DEPLOYMENT_GPT_4o"), 
       "GPT 4 Turbo": os.getenv("AZURE_DEPLOYMENT_GPT_4_TURBO")
    }
    print("api key: ", os.getenv("AZURE_OPENAI_API_KEY"))
    azure_openai = AzureOpenAI(
        api_key=os.getenv("AZURE_OPENAI_API_KEY"),  
        api_version=os.getenv("AZURE_API_VERSION"),
        azure_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
    )
    
    deployment_name=model_dict[model_option]
    
    print("using model: ", deployment_name)

    prompt= create_prompt(user_question, chat_history)

    start= time.time()

    response = azure_openai.chat.completions.create(
    model=deployment_name, 
    messages=[
        {
        "role": "user",
        "content": [
            {"type": "text", "text": prompt},
            {
            "type": "image_url",
            "image_url": {
                "url": f"{base64_image}",
            },
            },
        ],
        }
    ],
    max_tokens=4096
    )

    end=time.time()

    print("GPT Response:\n", response.choices[0].message.content)
    print(f'Time taken to get {deployment_name} response: ', end-start)

    print('-------------------')

    return response.choices[0].message.content

#------ Function to create prompt based on user question and chat history ------
def create_prompt(user_question, chat_history):
    if chat_history is not None:
      prompt= f"""
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
      prompt= f"""
Answer the following question in no more than 3 lines, based on the given image:
user question: {user_question}
Keep the following in mind:
- If a blue polygon is drawn over the image, its an area of interest. Object detection alerts have a bounding box and label in their respective colors.
- Never mention the previous chat history or any of the context provided to you in your response
- Analyze the image carefully before answering. If unsure about something in the image, simply state you can't answer. Don't invent new details.
- If asked questions unrelated to the image, just state that you cant answer this question.
"""
    return prompt

#------ Function to convert svg + xml formatted images to base64 jpg for image analysis by model ------
def convert_svgb64_to_jpgb64(svgstr):
    # Convert SVG to PNG in memory using CairoSVG
    png_data = cairosvg.svg2png(url=svgstr)
    # Convert PNG data to JPG format directly in memory
    with Image.open(BytesIO(png_data)) as img:
        # Convert to RGB mode since JPEG does not support alpha channels
        img = img.convert("RGB")
        # Save the image to a BytesIO buffer in JPEG format
        jpg_buffer = BytesIO()
        img.save(jpg_buffer, format="JPEG", quality=100, optimize=True)
        jpg_buffer.seek(0)  # Reset buffer position
    # Encode the JPG data to a base64 string
    jpg_base64 = base64.b64encode(jpg_buffer.read()).decode('utf-8')
    # Format the base64 string to include the data URL prefix
    jpg_base64_string = f"data:image/jpg;base64,{jpg_base64}"
    return jpg_base64_string

#################################################################################################

#------Function API to receive request body and send zip file buffer as response for downloading chat logs------
def download_image_analysis_chat_logs(b64img, chat_history): 
    try:
        zip_buffer= save_data_to_zip(b64img, chat_history)
        print("got zip buffer")
        current_date= datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
        zipfile_name= f"chat_log_{current_date}"
        print("date and zip name defined")
        headers = {
            'Content-Disposition': f'attachment; filename="{zipfile_name}.zip"',
            'Access-Control-Expose-Headers': 'Content-Disposition',
            'Access-Control-Allow-Origin': '"*"'
        }
        status_code=200
        print("headers and status code defined")
        return zip_buffer, headers, status_code
    
    except Exception as e:
       logging.info(msg=f'Following exception occured in download_image_analysis_chat_logs Function: {e}')
       status_code=400
       return f"An error occurred: {str(e)}", None,  status_code

#------ Function to create zip file buffer containing image jpg and chat history txt files ------    
def save_data_to_zip(image, chat_history):
    if image.startswith('data:image/svg+xml;base64,'):
        image= convert_svgb64_to_jpgb64(image)
    
    b64img= image.split(',')[-1]

    image_data= base64.b64decode(b64img)
    text_data= json.dumps(chat_history, indent=4)
    
    zip_buffer = BytesIO()

    with ZipFile(zip_buffer , 'w') as zip_object:
        zip_object.writestr('chat_logs.txt', text_data)
        zip_object.writestr('chat_image.jpg', image_data)

    zip_buffer.seek(0)
    print("created zip buffer")
    return zip_buffer