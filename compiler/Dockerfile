FROM python:3.12-slim

RUN pip install --no-cache-dir platformio==6.1.18 \
 && pio pkg install --global --platform espressif32 \
 && pio pkg install --global --platform atmelavr \
 && pio pkg install --global --platform raspberrypi

WORKDIR /app
COPY server.py .
ENV PLATFORMIO_CORE_DIR=/root/.platformio
CMD ["python", "server.py"]
