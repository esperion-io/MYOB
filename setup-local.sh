#!/bin/sh
# RETIRED in 1.19. This script used to SSH `printenv` off the Render service,
# overwrite .env with production's settings (database, MYOB key and secret)
# and start the app on them. Production's MYOB login is a single-use refresh
# token, so a local run on those settings could break production's MYOB
# connection. It now does nothing.
#
# Develop on the local copy instead: see CLAUDE.md in the folder above this
# repository (allied/CLAUDE.md), and "Run locally" in readme.md.
echo "setup-local.sh is retired: it copied production's settings into .env." >&2
echo "Develop on the local copy instead; see CLAUDE.md in the folder above this repository (allied/CLAUDE.md)." >&2
exit 1
