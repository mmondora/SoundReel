FROM python:3.12-slim

ARG GIT_REVISION=unknown
ARG BUILD_DATE=
LABEL org.opencontainers.image.revision=$GIT_REVISION
LABEL org.opencontainers.image.created=$BUILD_DATE
LABEL org.opencontainers.image.title="soundreel-instaloader"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app.py .

RUN mkdir -p /root/.config/instaloader /data/media

VOLUME /data/media

EXPOSE 5000

CMD ["gunicorn", "-b", "0.0.0.0:5000", "-w", "2", "--threads", "4", "--timeout", "180", "app:app"]
