# CodeLens AI: web app + API in one image.
# User code never runs in this container: the API starts a separate, locked-down
# codelens-worker container per run through the host's Docker (see docker-compose.yml).

# ---- 1. build the React workspace -------------------------------------------
FROM node:22-slim AS ui
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- 2. API runtime -----------------------------------------------------------
FROM python:3.12-slim
ARG DOCKER_CLI_VERSION=27.3.1
# Only the Docker *client* is needed; it talks to the host daemon through the mounted socket.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL "https://download.docker.com/linux/static/stable/$(uname -m)/docker-${DOCKER_CLI_VERSION}.tgz" \
       | tar -xz --strip-components=1 -C /usr/local/bin docker/docker \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY --from=ui /src/frontend/dist /app/frontend/dist

ENV CODELENS_SANDBOX=docker \
    CODELENS_DB_PATH=/app/backend/data/codelens.db \
    PYTHONUNBUFFERED=1
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
