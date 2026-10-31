"""gem-proctor verification sandbox (SPEC §3A.3.1). Runs before anything imports NumPy."""

import os

# OpenBLAS would start worker threads (and map their buffers): a child has no process budget to restart them,
# and they'd use up its address space.
os.environ.update(OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1", MKL_NUM_THREADS="1")
