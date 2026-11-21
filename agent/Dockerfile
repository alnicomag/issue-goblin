FROM python:3.12-slim
RUN useradd --uid 10001 --create-home agent
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
USER 10001
CMD ["python", "app.py", "worker"]
