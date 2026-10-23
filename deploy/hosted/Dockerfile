# CodeLens AI for hosting services that run one container (Render, Hugging Face Spaces, ...):
# web app, API and /mcp together. These hosts can't start Docker containers, so user code runs in
# the subprocess sandbox: a separate,
# resource-limited Python process with a bare environment. The server hides its own environment
# (secrets) from those processes, and an access code keeps strangers out.

# ---- 1. build the React workspace -------------------------------------------
FROM node:22-slim AS ui
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- 2. API runtime (uid 1000, as Hugging Face Spaces expect) ------------------
FROM python:3.12-slim
RUN useradd -m -u 1000 user
WORKDIR /app/backend
COPY backend/requirements.txt ./
# pytest validates fixes; numpy is available to user programs, as in the Docker sandbox image.
RUN pip install --no-cache-dir -r requirements.txt "pytest==8.3.3" "numpy==2.1.3"
COPY backend/ ./
COPY --from=ui /src/frontend/dist /app/frontend/dist
RUN mkdir -p /app/rea-workspace && chown -R user /app/rea-workspace
USER user

ENV CODELENS_SANDBOX=subprocess \
    CODELENS_DB_PATH=/tmp/codelens.db \
    PYTHONUNBUFFERED=1
# Render (and others) pass the port in $PORT; Hugging Face uses 7860.
EXPOSE 7860
CMD ["sh", "-c", "exec python -m uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860} --proxy-headers --forwarded-allow-ips '*'"]
