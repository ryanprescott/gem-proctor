import os

from . import vlm_shim
from .config import Config
from .server import serve

if __name__ == "__main__":
    # Before the worker starts, so it inherits SURYA_INFERENCE_URL.
    upstream = os.environ.get("CONVERT_VLM_UPSTREAM")
    if upstream:
        print(f"convert: vision model through the development shim at {vlm_shim.start(upstream)}", flush=True)
    serve(Config.from_env())
