# The Playwright image ships the matching Chromium and its system libraries.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production PORT=8091 DATA_DIR=/data
USER pwuser
EXPOSE 8091
CMD ["node", "server.js"]
