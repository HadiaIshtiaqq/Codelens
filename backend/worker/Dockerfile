# CodeLens AI sandbox worker image.
# Build: docker build -t codelens-worker:latest backend/worker
# The API launches it with --network none --read-only --cap-drop ALL etc.
# (see app/services/sandbox.py); none of those flags are baked in here.
FROM python:3.12-slim

# pytest powers patch validation (fixtures, parametrize, raises); numpy is the most
# requested library in learner and data-science code. The network is disabled at run
# time, so packages must be baked in here.
RUN pip install --no-cache-dir "pytest==8.3.3" "numpy==2.1.3" \
    && groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin sandbox

COPY tracer.py /opt/codelens/tracer.py
RUN chmod 0444 /opt/codelens/tracer.py

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8
WORKDIR /tmp
USER 10001:10001

ENTRYPOINT ["python", "-I", "/opt/codelens/tracer.py"]
