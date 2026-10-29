#!/usr/bin/env bash
# Setup helper: install Node from the official nodejs.org prebuilt tarball.
#
# Linux (glibc and musl) and macOS (Intel and Apple Silicon). Does not compile
# Node, and does not use nodeenv, Homebrew, or NodeSource — those can build
# from source when a bottle or distro package is missing.
#
# Bash 3.2 compatible so macOS /bin/bash can run it. Pure bash — runs before
# a new-enough Node exists on the host.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/node-version.sh
source "$PROJECT_ROOT/setup/lib/node-version.sh"

echo "=== NANOCLAW SETUP: INSTALL_NODE ==="

LOCAL_BIN="${HOME}/.local/bin"
mkdir -p "$LOCAL_BIN"
# Prefer a Node this script already unpacked over an older system Node.
export PATH="${LOCAL_BIN}:${PATH:-}"

node_meets_minimum() {
  command -v node >/dev/null 2>&1 || return 1
  local ver
  ver=$(node --version 2>/dev/null | sed 's/^v//')
  [ -n "$ver" ] || return 1
  nanoclaw_version_ge "$ver" "$NANOCLAW_MIN_NODE_VERSION"
}

if node_meets_minimum; then
  echo "STATUS: already-installed"
  echo "NODE_VERSION: $(node --version)"
  echo "=== END ==="
  exit 0
fi

echo "STEP: download-prebuilt"
echo "Installing prebuilt Node.js v${NANOCLAW_MIN_NODE_VERSION} from nodejs.org"

os=""
case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *)
    echo "STATUS: failed"
    echo "ERROR: Unsupported platform: $(uname -s). Install Node.js ${NANOCLAW_MIN_NODE_VERSION}+ from https://nodejs.org and re-run."
    echo "=== END ==="
    exit 1
    ;;
esac

arch=""
case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *)
    echo "STATUS: failed"
    echo "ERROR: Unsupported architecture: $(uname -m). Install Node.js ${NANOCLAW_MIN_NODE_VERSION}+ from https://nodejs.org and re-run."
    echo "=== END ==="
    exit 1
    ;;
esac

# Official musl tarballs are named linux-<arch>-musl. Node 26.13 publishes
# that build for x64 only. glibc Linux and macOS have no suffix.
libc_suffix=""
if [ "$os" = "linux" ]; then
  if [ -f /etc/alpine-release ] \
    || ls /lib/ld-musl-*.so.1 >/dev/null 2>&1 \
    || ls /usr/lib/ld-musl-*.so.1 >/dev/null 2>&1; then
    libc_suffix="-musl"
  elif command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
    libc_suffix="-musl"
  fi
  if [ -n "$libc_suffix" ] && [ "$arch" != "x64" ]; then
    echo "STATUS: failed"
    echo "ERROR: Node.js ${NANOCLAW_MIN_NODE_VERSION} has no musl prebuilt for linux-${arch}. Use a glibc distro (Debian, Ubuntu, Fedora) or install Node ${NANOCLAW_MIN_NODE_VERSION}+ yourself."
    echo "=== END ==="
    exit 1
  fi
fi

ver="$NANOCLAW_MIN_NODE_VERSION"
name="node-v${ver}-${os}-${arch}${libc_suffix}"
base="https://nodejs.org/dist/v${ver}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL "${base}/${name}.tar.gz" -o "${work}/${name}.tar.gz"
curl -fsSL "${base}/SHASUMS256.txt" -o "${work}/SHASUMS256.txt"
expected=$(awk -v file="${name}.tar.gz" '$2 == file { print $1; exit }' "${work}/SHASUMS256.txt")
if [ -z "$expected" ]; then
  echo "STATUS: failed"
  echo "ERROR: No checksum for ${name}.tar.gz in SHASUMS256.txt"
  echo "=== END ==="
  exit 1
fi

# GNU coreutils (Linux) or perl shasum (macOS). Same "hash  filename" line.
if ! (
  cd "$work"
  if command -v sha256sum >/dev/null 2>&1; then
    echo "${expected}  ${name}.tar.gz" | sha256sum -c -
  elif command -v shasum >/dev/null 2>&1; then
    echo "${expected}  ${name}.tar.gz" | shasum -a 256 -c -
  else
    echo "ERROR: Need sha256sum (Linux) or shasum (macOS) to verify the Node tarball" >&2
    exit 1
  fi
); then
  echo "STATUS: failed"
  echo "ERROR: Checksum verification failed for ${name}.tar.gz"
  echo "=== END ==="
  exit 1
fi

prefix="${HOME}/.local/share/nanoclaw/${name}"
rm -rf "$prefix"
mkdir -p "$(dirname "$prefix")"
tar -xzf "${work}/${name}.tar.gz" -C "$(dirname "$prefix")"
# The tarball unpacks to a directory of the same name.
if [ ! -x "${prefix}/bin/node" ]; then
  echo "STATUS: failed"
  echo "ERROR: Prebuilt Node tarball did not contain bin/node"
  echo "=== END ==="
  exit 1
fi

run_priv() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    return 1
  fi
}

# Linux binaries since Node 25 link against libatomic. The package is a
# distro binary, not a from-source build. macOS binaries do not need it.
install_libatomic() {
  if command -v apt-get >/dev/null 2>&1; then
    run_priv apt-get install -y libatomic1
  elif command -v dnf >/dev/null 2>&1; then
    run_priv dnf install -y libatomic
  elif command -v yum >/dev/null 2>&1; then
    run_priv yum install -y libatomic
  elif command -v zypper >/dev/null 2>&1; then
    run_priv zypper --non-interactive install libatomic1
  elif command -v apk >/dev/null 2>&1; then
    run_priv apk add --no-cache libatomic
  else
    return 1
  fi
}

start_err=""
if ! start_err=$("${prefix}/bin/node" --version 2>&1); then
  echo "$start_err"
  if [ "$os" = "linux" ]; then
    echo "STEP: libatomic"
    install_libatomic || echo "NOTE: could not install libatomic automatically"
  fi
fi

if ! "${prefix}/bin/node" --version >/dev/null 2>&1; then
  echo "STATUS: failed"
  if [ "$os" = "linux" ]; then
    echo "ERROR: Prebuilt Node failed to start. Install libatomic (libatomic1 on Debian/Ubuntu) and re-run."
  else
    echo "ERROR: Prebuilt Node failed to start on macOS."
  fi
  echo "=== END ==="
  exit 1
fi

# rm then ln: macOS ln -sfn follows a symlink-to-directory; these targets are files.
for bin in node npm npx corepack; do
  if [ -e "${prefix}/bin/${bin}" ]; then
    rm -f "${LOCAL_BIN}/${bin}"
    ln -s "${prefix}/bin/${bin}" "${LOCAL_BIN}/${bin}"
  fi
done
hash -r 2>/dev/null || true

if ! node_meets_minimum; then
  echo "STATUS: failed"
  echo "ERROR: node on PATH is still older than v${NANOCLAW_MIN_NODE_VERSION} after install ($(command -v node 2>/dev/null || echo missing))"
  echo "=== END ==="
  exit 1
fi

echo "STATUS: installed"
echo "NODE_VERSION: $(node --version)"
echo "=== END ==="
