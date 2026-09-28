FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY health_agent.py .

CMD ["python", "-u", "health_agent.py"]
