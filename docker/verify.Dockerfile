# Verify sandbox (SPEC §3A.3.1, §11.5): a parent that forks one unprivileged child per run.
FROM python:3.12.8-slim-bookworm

# The unprivileged user children switch to. Keep in step with RUNNER_UID in gem_verify/child.py. The user files
# are unreadable to it: nothing needs them, so a program reading them is a denial, not a quiet success.
RUN groupadd --gid 10002 runner && useradd --uid 10002 --gid runner --no-create-home --shell /usr/sbin/nologin runner \
 && chmod 0640 /etc/passwd /etc/group

COPY apps/verify/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt \
 && python -m compileall -q /usr/local/lib/python3.12

COPY apps/verify/gem_verify /app/gem_verify
RUN python -m compileall -q /app/gem_verify \
 && mkdir -p /run/verify && chmod 755 /run/verify

WORKDIR /app
# The parent needs SETUID/SETGID (and nothing else) to drop children to `runner`; Compose drops every other
# capability. `--require-privdrop` makes it refuse to start, or to run a child, if the drop can't happen.
# `env -i` and `-I` start it with no environment variables at all; `-B` never writes .pyc (the root filesystem
# is read-only).
ENTRYPOINT ["/usr/bin/env", "-i", "/usr/local/bin/python", "-I", "-B", "/app/gem_verify/server.py", "--require-privdrop"]
CMD ["/run/verify/verify.sock"]
