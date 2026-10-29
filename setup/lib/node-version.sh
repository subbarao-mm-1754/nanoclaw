# Shared Node version floor for setup.sh and setup/install-node.sh.
# Source this file — do not execute it.
# Bash 3.2 compatible (macOS /bin/bash).

# Host requirement. The installer downloads this exact official prebuilt
# release when nothing on PATH is new enough. A newer Node already on PATH
# is left in place.
NANOCLAW_MIN_NODE_VERSION=26.13.0

# 0 when $1 >= $2. Compares the first three numeric dot-components.
nanoclaw_version_ge() {
  local a=$1 b=$2
  local am=0 aj=0 ap=0 bm=0 bj=0 bp=0
  local _rest
  IFS=. read -r am aj ap _rest <<< "$a"
  IFS=. read -r bm bj bp _rest <<< "$b"
  am=${am%%[^0-9]*}; aj=${aj%%[^0-9]*}; ap=${ap%%[^0-9]*}
  bm=${bm%%[^0-9]*}; bj=${bj%%[^0-9]*}; bp=${bp%%[^0-9]*}
  am=${am:-0}; aj=${aj:-0}; ap=${ap:-0}
  bm=${bm:-0}; bj=${bj:-0}; bp=${bp:-0}
  if [ "$am" -gt "$bm" ]; then return 0; fi
  if [ "$am" -lt "$bm" ]; then return 1; fi
  if [ "$aj" -gt "$bj" ]; then return 0; fi
  if [ "$aj" -lt "$bj" ]; then return 1; fi
  if [ "$ap" -gt "$bp" ]; then return 0; fi
  if [ "$ap" -lt "$bp" ]; then return 1; fi
  return 0
}
