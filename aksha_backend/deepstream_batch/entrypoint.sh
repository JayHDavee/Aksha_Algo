#!/bin/sh
set -e

# The pip-installed nvidia-*-cu11 packages (see dockerfile) ship their .so
# files under <site-packages>/nvidia/<component>/lib/ — not on the default
# linker search path. Compute it at startup rather than hardcoding a
# site-packages path (see the PYSITE lookup in the dockerfile's OpenCV build
# step — that path isn't guaranteed stable across base image updates).
NVLIB=$(python3 -c "
import glob, os, site
base = os.path.join(site.getsitepackages()[0], 'nvidia')
print(':'.join(glob.glob(os.path.join(base, '*', 'lib'))))
")

export LD_LIBRARY_PATH="${NVLIB}:${LD_LIBRARY_PATH}"
exec python3 app/main.py
