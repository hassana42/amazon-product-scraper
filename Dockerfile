FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 CHROMA_PATH=/data/chroma
WORKDIR /app
COPY requirements.txt .
RUN python -m pip install --no-cache-dir --upgrade "pip>=26.2" \
    && python -m pip install --no-cache-dir -r requirements.txt \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app app \
    && install -d -o app -g app /data/chroma
COPY backend/ backend/
COPY marketplaces.json .
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"
CMD ["python", "-m", "uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000"]
