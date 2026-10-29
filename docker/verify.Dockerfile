# Verify sandbox (SPEC §3A.3.1, §11.5). P0: the parent process answers health only.
FROM python:3.12.8-slim-bookworm

# The unprivileged user model children will switch to in P2.1 (fork per run).
RUN groupadd --gid 10002 runner && useradd --uid 10002 --gid runner --no-create-home --shell /usr/sbin/nologin runner

COPY apps/verify/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt \
 && python -m compileall -q /usr/local/lib/python3.12

COPY apps/verify/gem_verify /app/gem_verify
RUN python -m compileall -q /app/gem_verify \
 && mkdir -p /run/verify && chmod 755 /run/verify

WORKDIR /app
# The parent needs SETUID/SETGID (and nothing else) to drop children to `runner` in P2.1; Compose drops every
# other capability. `env -i` and `-I` start it with no environment variables at all; `-B` never writes .pyc
# (the root filesystem is read-only).
ENTRYPOINT ["/usr/bin/env", "-i", "/usr/local/bin/python", "-I", "-B", "/app/gem_verify/server.py"]
CMD ["/run/verify/verify.sock"]
