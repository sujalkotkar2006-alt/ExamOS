FROM node:24-trixie-slim

# Python validates existing silent event clips. No camera or detector runs here.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY server/requirements-media.txt ./server/requirements-media.txt
RUN python3 -m venv /opt/examos-media \
    && /opt/examos-media/bin/pip install --no-cache-dir -r server/requirements-media.txt
COPY dashboard ./dashboard
RUN npm run build && npm prune --omit=dev
COPY server ./server
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 EXAMOS_MEDIA_PYTHON=/opt/examos-media/bin/python
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
