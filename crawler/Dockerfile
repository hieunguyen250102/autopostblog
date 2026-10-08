FROM python:3.12-slim

# Chromium + chromedriver cùng phiên bản từ Debian (không phải tải driver lúc chạy).
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium chromium-driver fonts-noto-core fonts-noto-color-emoji tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
 # SeleniumBase ưu tiên driver trong thư mục drivers/ của nó => dùng đúng driver của Debian.
 && cp /usr/bin/chromedriver "$(python -c 'import seleniumbase, os; print(os.path.dirname(seleniumbase.__file__))')/drivers/"

COPY app.py fbparse.py ./

ENV CHROME_BIN=/usr/bin/chromium \
    PORT=8000 \
    TZ=Asia/Ho_Chi_Minh \
    PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python", "app.py"]
