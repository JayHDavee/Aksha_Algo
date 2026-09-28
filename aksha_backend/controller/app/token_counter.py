"""
token_counter — GPT-4o token counting helpers.

Used by alert_report_analyzer to guard against exceeding the model's context window
before making an expensive API call.

  count_text_tokens(text)   — tiktoken encode with gpt-4o BPE, return token count
  count_image_tokens(w, h)  — OpenAI tile-based image token formula:
                               resize to fit 1024×1024 → ceil to 512-px tiles → 85 + 170×H×W tiles
"""

from math import ceil
import tiktoken


def resize(width, height):
    """Scale *width* and *height* down so neither exceeds 1024, preserving aspect ratio."""
    if width > 1024 or height > 1024:
        if width > height:
            height = int(height * 1024 / width)
            width = 1024
        else:
            width = int(width * 1024 / height)
            height = 1024
    return width, height


def count_image_tokens(width: int, height: int):
    """
    Return the number of GPT-4 vision tokens consumed by an image of *width* × *height*.

    Formula: resize to ≤1024 px, split into 512-px tiles, apply 85 + 170×tiles.
    Source: OpenAI image token pricing documentation.
    """
    width, height = resize(width, height)
    h = ceil(height / 512)
    w = ceil(width / 512)
    return 85 + 170 * h * w


def count_text_tokens(text: str):
    """Return the number of GPT-4o tokens in *text* using tiktoken BPE encoding."""
    encoding = tiktoken.encoding_for_model("gpt-4o")
    return len(encoding.encode(text))
