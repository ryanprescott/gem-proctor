# PDF converter (docs/P2.2.md §5): Marker in a small service of ours. PDFs are untrusted input to a parser with a large
# native surface, so the image holds everything it needs (the weights are baked in) and Compose runs it read-only, with
# no capabilities and no secrets. The vision model is not here: it runs on the Ollama box, reached through the API.
FROM python:3.12.8-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10003 convert && useradd --uid 10003 --gid convert --no-create-home --shell /usr/sbin/nologin convert

# CPU PyTorch first, so that Marker's requirements find torch and torchvision already installed and matching: pip
# otherwise pulls a torchvision that does not fit the CPU torch.
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu
COPY apps/convert/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Bake the weights Marker's own models need (a layout model from Hugging Face and an OCR-error detector from Datalab's
# storage, about 400 MB): the detector is loaded once, and one conversion of a text PDF in fast mode, with the vision
# model off, fetches the layout model. At runtime the image is offline.
ENV XDG_CACHE_HOME=/opt/baked HF_HOME=/opt/baked/hf
COPY apps/convert/tests/fixtures/linear-algebra.pdf /tmp/warm.pdf
RUN python -c "from surya.ocr_error import OCRErrorPredictor; OCRErrorPredictor.local()" \
 && marker_single /tmp/warm.pdf --output_dir /tmp/warm-out --mode fast --disable_ocr \
 && rm -rf /tmp/warm.pdf /tmp/warm-out /opt/baked/datalab/surya /root/.cache \
 && test -d /opt/baked/datalab/models/ocr_error_detection \
 && chmod -R a+rX /opt/baked

COPY apps/convert/gem_convert /app/gem_convert
COPY docker/convert-entrypoint.sh /app/entrypoint.sh
RUN python -m compileall -q /app/gem_convert && chmod 0755 /app/entrypoint.sh

WORKDIR /app
USER 10003:10003
# The baked weights are read from /opt/baked (XDG_CACHE_HOME is where Surya looks for its models). Surya also writes lock
# and log files under ~/.cache, so HOME is the tmpfs at /cache.
ENV HOME=/cache XDG_CACHE_HOME=/opt/baked HF_HOME=/opt/baked/hf HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    CONVERT_HOST=0.0.0.0 CONVERT_PORT=8200 CONVERT_WORK_DIR=/work PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8200
ENTRYPOINT ["/app/entrypoint.sh"]
