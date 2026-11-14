# The Playwright image ships the matching Chromium and its system libraries.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

# PulseAudio gives Chromium a virtual sound card; Xvfb a virtual screen for the H.264 stream;
# ffmpeg captures both and repackages video.
RUN apt-get update \
  && apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils xvfb openbox ffmpeg \
  && rm -rf /var/lib/apt/lists/*
# yt-dlp follows site changes closely, so each image build takes the newest release.
ADD --chmod=755 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js audio.js video.js vstream.js entrypoint.sh ./
COPY public ./public

ENV NODE_ENV=production PORT=8091 DATA_DIR=/data
USER pwuser
EXPOSE 8091
CMD ["./entrypoint.sh"]
