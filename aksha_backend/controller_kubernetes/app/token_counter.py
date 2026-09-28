from math import ceil
import tiktoken

def resize(width, height):
    if width > 1024 or height > 1024:
        if width > height:
            height = int(height * 1024 / width)
            width = 1024
        else:
            width = int(width * 1024 / height)
            height = 1024
    return width, height

def count_image_tokens(width: int, height: int):
    width, height = resize(width, height)
    h = ceil(height / 512)
    w = ceil(width / 512)
    total = 85 + 170 * h * w
    return total

def count_text_tokens(text: str):
    encoding = tiktoken.encoding_for_model("gpt-4o")
    text_tokens_count= len(encoding.encode(text))
    return text_tokens_count