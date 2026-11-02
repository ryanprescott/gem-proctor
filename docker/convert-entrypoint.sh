#!/bin/sh
# The lowest CPU priority keeps a conversion from starving the API or Postgres when they share a host
# (docs/P2.2.md §5 "Low priority"). HOME is a tmpfs: Surya writes its lock and log files there.
set -eu
mkdir -p "$HOME/.cache/datalab/surya"
exec nice -n 19 python -m gem_convert
