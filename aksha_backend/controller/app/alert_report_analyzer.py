"""
alert_report_analyzer — LLM-based alert trend report generator.

Pipeline:

  filtered_data (JSON from frontend)
    → create_pivot_dataframe()   transform alerts → daily pivot table per camera
    → create_prompt()            embed pivot table + OD counts into GPT prompt
    → get_summary_and_insights() count tokens, call Azure GPT, return analysis text
    → alert_report_analyzer()    pack result as JSON response with status code

  Azure models supported: GPT 4o, GPT 4 Turbo (configured via .env)
  Token limit guard: 127 999 tokens — returns error if prompt exceeds this.
"""

import logging
from openai import AzureOpenAI
import os
import time
import pandas as pd
from collections import defaultdict
from datetime import datetime
import json
from token_counter import count_text_tokens
from dotenv import load_dotenv
import sys

exe_file = sys.executable
exe_parent = os.path.dirname(exe_file)
dotenv_path = os.path.join(exe_parent, ".env")
load_dotenv(dotenv_path=dotenv_path)


def alert_report_analyzer(filtered_data, start_date, end_date, model_option, lang_option):
    """
    Entry point — receive alert data and return an LLM-generated trend report.

    Returns:
      (result_json, mimetype, status_code)
        result_json — {"report_analysis": str, "message": "success"|"failed: ..."}
    """
    try:
        # Transform the received alert report data into a pivot dataframe and
        # a per-camera total OD alert count dictionary
        pivot_dataframe, total_object_detection_alerts_cam_wise = create_pivot_dataframe(filtered_data)
        # Run LLM analysis on the transformed data
        report_analysis, isSuccess = get_summary_and_insights(
            start_date, end_date, pivot_dataframe,
            total_object_detection_alerts_cam_wise, model_option, lang_option
        )

        if not isSuccess:
            result = json.dumps({'report_analysis': "", 'message': f'failed: {report_analysis}'})
            return result, "application/json", 400

        result = json.dumps({'report_analysis': str(report_analysis), 'message': 'success'})
        logging.info('Alert report analysis completed successfully.')
        return result, "application/json", 200

    except Exception as e:
        logging.error(f'Exception in alert_report_analyzer: {e}')
        result = json.dumps({'report_analysis': "", 'message': f'failed: {e}'})
        return result, "application/json", 500


def get_summary_and_insights(start_date, end_date, data, total_object_detection_alerts_cam_wise, model_option, lang_option):
    """
    Build the GPT prompt, check token count, call Azure OpenAI, and return the response.

    Returns:
      (text, success_bool)
        text — model response string, or an error/limit message
    """
    model_dict = {
        "GPT 4o":       os.getenv("AZURE_DEPLOYMENT_GPT_4o"),
        "GPT 4 Turbo":  os.getenv("AZURE_DEPLOYMENT_GPT_4_TURBO"),
    }
    prompt_query = create_prompt(start_date, end_date, data, total_object_detection_alerts_cam_wise, lang_option)

    # Count tokens before sending — prompt includes instructions + entire pivot table
    text_tokens = count_text_tokens(prompt_query)

    if data is None:
        return "No alerts were found within the specified date and time range for report analysis.", False

    if text_tokens >= 127999:
        # Prompt exceeds context window — ask user to narrow the date range
        return "Data for the selected range has reached the maximum token limit. Please try with shorter date and time range.", False

    azure_openai = AzureOpenAI(
        api_key=os.getenv("AZURE_OPENAI_API_KEY"),
        api_version=os.getenv("AZURE_API_VERSION"),
        azure_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT")
    )

    deployment_name = model_dict[model_option]
    logging.info(f"Calling Azure GPT | model={deployment_name} | tokens={text_tokens}")

    start = time.time()
    response = azure_openai.chat.completions.create(
        model=deployment_name,
        messages=[{"role": "user", "content": [{"type": "text", "text": prompt_query}]}]
    )
    elapsed = time.time() - start

    response_tokens = count_text_tokens(response.choices[0].message.content)
    logging.info(f"GPT response received | elapsed={elapsed:.1f}s | input_tokens={text_tokens} | output_tokens={response_tokens}")

    return response.choices[0].message.content, True


def create_pivot_dataframe(data):
    """
    Transform raw alert JSON into a daily pivot table per camera.

    Returns:
      (pivot_df, total_od_alerts_cam_wise)
        pivot_df               — DataFrame indexed by [Camera, Date, Total Daily Alerts]
                                 with one column per object class; None if no alerts
        total_od_alerts_cam_wise — {cam_name: total_OD_alert_count}
    """
    processed_data = []
    daily_counts = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    total_object_detection_alerts_cam_wise = {}
    all_alerts_empty = True  # flag — becomes False as soon as any alert is found

    for camera, camera_data in data.items():
        if camera == 'report_summary':
            continue
        # Accumulate per-camera OD alert totals for the prompt context
        total_object_detection_alerts_cam_wise[camera] = camera_data['object_detection_alerts']
        if not camera_data.get('alerts', {}):
            continue

        all_alerts_empty = False
        for alert_time, alert_details in camera_data['alerts'].items():
            alert_date = datetime.strptime(alert_details['timestamp'], "%Y-%m-%d %H:%M:%S").date()
            object_class = alert_details['object']
            daily_counts[camera][alert_date][object_class] += 1

    if all_alerts_empty:
        return None, total_object_detection_alerts_cam_wise

    for camera, dates in daily_counts.items():
        for date, object_classes in dates.items():
            total_alerts_for_day = sum(object_classes.values())
            for object_class, count in object_classes.items():
                processed_data.append({
                    'Camera Name':            camera,
                    'Date':                   date,
                    'Object Class':           object_class,
                    'Alert Count':            count,
                    'Total Alerts for the Day': total_alerts_for_day,
                })

    df = pd.DataFrame(processed_data)

    # Pivot: compress object classes into columns — reduces token count significantly
    pivot_df = pd.pivot_table(
        df,
        index=['Camera Name', 'Date', 'Total Alerts for the Day'],
        columns='Object Class',
        values='Alert Count',
        fill_value=0
    ).reset_index()

    return pivot_df, total_object_detection_alerts_cam_wise


def create_prompt(start_date, end_date, data, total_object_detection_alerts_cam_wise, lang_option):
    """Build the full GPT prompt string embedding the pivot table and OD summary dict."""
    prompt_query = f"""
As a helpful security assistant, based on the following alert dataframe for the date range {start_date} to  {end_date}, generate an insightful report which provides a 1 line summary of all the events, camera-wise.
Provide the complete report strictly in {lang_option} language.
For the camera-wise summary, use the total_object_detection_alerts_cam_wise dictionary to write the summary, as specified in the format below.
Alert counts can be taken from the respective object label column for the day which will be present for each camera and date.
For context: no person alerts occur where a person is supposed to be there, but isnt.
Important: Dont mention any other object detection alerts apart from the ones present in the data.

Next, do a trend analysis, which answers questions such as:
- were there any upward or downward trends for any particular object detections over the provided date range?
- what are its implications on the security status of the premises?
- any other insights, change points or qualitative/quantitative analysis that can be uncovered from the data?
Keep the trend analysis concise, but insightful, mentioning numbers, percentages, dates etc. wherever possible, to explain your analysis.

Then, provide a concise Suggested Actionable Plan for the alerts related to worker's safety or overall security threats, if needed.
If there are no significant security or safety issues noted, mention the same in the report.

Follow the below format strictly. Translate the headings and all the content to {lang_option} as needed:
## Summary for the Period of ~start_date~ to ~end_date~
- cam_name1: object_1 detected x times: summary of the events for that object. object_2 detected y times: summary.
- cam_name2: ...follow suit.
## Insights
### Trends Observed
~trend analysis bullet points go here~
### Other Insights
~other insights noted go here~
## Suggested Actionable Plan
~maximum 3 bullet points, one line each, for the plan go here~

total_object_detection_alerts_cam_wise: {total_object_detection_alerts_cam_wise}
Dataframe: {data}
    """
    return prompt_query
