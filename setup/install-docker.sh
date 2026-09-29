#!/usr/bin/env bash
# Setup helper: install-docker — installs the container runtime used by NanoClaw.
#
#   macOS  → Prefer existing Docker Desktop if present; otherwise use/install
#            Colima + Docker CLI (Homebrew formulae). Never installs Docker Desktop.
#   Linux  → Podman + podman-docker CLI shim (+ Compose provider)
#            so `docker` / `docker compose` talk to Podman. Does NOT install
#            Docker Engine (get.docker.com).
#
# Bundled as one script so /new-setup can run it without needing `curl | sh`
# in the allowlist (pipelines split at matching time, and `sh` receiving
# stdin can't be pre-approved safely).
#
# The script itself is the allowlisted unit; the pipes and sudo live inside
# it. Starting the runtime (after install) stays separate — `open -a Docker`
# or `colima start` on macOS, `systemctl --user start podman.socket` on Linux.
set -euo pipefail

echo "=== NANOCLAW SETUP: INSTALL_DOCKER ==="

is_wsl() {
  [ -f /proc/version ] && grep -qi 'microsoft\|wsl' /proc/version 2>/dev/null
}

macos_docker_desktop_installed() {
  [ -d "/Applications/Docker.app" ] || [ -d "${HOME}/Applications/Docker.app" ]
}

ensure_compose_provider() {
  # Prefer an existing Compose provider; otherwise install Compose v2 into
  # ~/.local/bin (no Docker Engine / Desktop repo required).
  if docker compose version >/dev/null 2>&1; then
    echo "COMPOSE: $(docker compose version 2>/dev/null | head -1)"
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    echo "COMPOSE: $(docker-compose version 2>/dev/null | head -1)"
    return 0
  fi

  echo "STEP: install-docker-compose"
  local arch os_name archive url dest
  os_name="$(uname -s)"
  case "$(uname -m)" in
    x86_64|amd64) arch="x86_64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *)
      echo "NOTE: unknown arch $(uname -m) — skip Compose auto-install"
      return 0
      ;;
  esac
  archive="docker-compose-${os_name}-${arch}"
  # Pin via GitHub "latest" redirect is fine here; Compose is not under the
  # nanoclaw pnpm release-age policy.
  url="https://github.com/docker/compose/releases/latest/download/${archive}"
  dest="${HOME}/.local/bin/docker-compose"
  mkdir -p "$(dirname "$dest")"
  if curl -fsSL "$url" -o "$dest"; then
    chmod +x "$dest"
    export PATH="$(dirname "$dest"):$PATH"
    echo "COMPOSE: installed $dest"
    docker-compose version 2>/dev/null | head -1 || true
  else
    echo "NOTE: Compose download failed — OneCLI/docker compose may need a manual install"
  fi
}

ensure_macos_docker_cli() {
  # Colima needs the Docker CLI formulae (not Docker Desktop cask).
  if ! command -v brew >/dev/null 2>&1; then
    echo "STATUS: failed"
    echo "ERROR: Homebrew not installed. Install brew first (https://brew.sh) then re-run."
    echo "=== END ==="
    exit 1
  fi
  local pkgs=()
  command -v docker >/dev/null 2>&1 || pkgs+=(docker)
  # docker-compose formula provides the compose plugin / binary for Colima users.
  if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
    pkgs+=(docker-compose)
  fi
  if [ "${#pkgs[@]}" -gt 0 ]; then
    echo "STEP: brew-install-docker-cli (${pkgs[*]})"
    brew install "${pkgs[@]}"
  fi
  ensure_compose_provider
}

enable_podman_sockets() {
  echo "STEP: enable-podman-socket"
  # Rootless API used by the docker shim for the current user.
  systemctl --user enable --now podman.socket >/dev/null 2>&1 || true
  # Linger so the user socket stays up after logout/SSH (common on servers/WSL).
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  fi
  # System socket backs /var/run/docker.sock → /run/podman/podman.sock on many distros.
  # Use `sudo -n` so an already-installed re-run never hangs on a password prompt.
  if command -v systemctl >/dev/null 2>&1; then
    sudo -n systemctl enable --now podman.socket >/dev/null 2>&1 || true
  fi
}

install_linux_podman() {
  echo "STEP: install-podman"
  if is_wsl; then
    echo "IS_WSL: true"
  else
    echo "IS_WSL: false"
  fi

  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y podman podman-docker
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y podman podman-docker
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y podman podman-docker
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper --non-interactive install podman podman-docker
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm podman podman-docker
  else
    echo "STATUS: failed"
    echo "ERROR: No supported package manager (apt/dnf/yum/zypper/pacman). Install podman and podman-docker manually."
    echo "=== END ==="
    exit 1
  fi

  # Quiet the "Emulate Docker CLI using podman" banner on every invoke.
  if [ -d /etc/containers ]; then
    sudo touch /etc/containers/nodocker 2>/dev/null || true
  fi

  enable_podman_sockets
  ensure_compose_provider
}

# macOS: Docker Desktop (if already installed) → else Colima (reuse or install).
# Never installs Docker Desktop.
install_or_reuse_macos() {
  if macos_docker_desktop_installed; then
    echo "STATUS: already-installed"
    echo "RUNTIME: docker-desktop"
    echo "DOCKER_VERSION: $(docker --version 2>/dev/null || echo 'Docker Desktop present (CLI may appear after first launch)')"
    echo "=== END ==="
    exit 0
  fi

  if command -v colima >/dev/null 2>&1; then
    echo "STATUS: already-installed"
    echo "RUNTIME: colima"
    echo "COLIMA_VERSION: $(colima version 2>/dev/null | head -1 || echo unknown)"
    ensure_macos_docker_cli
    echo "DOCKER_VERSION: $(docker --version 2>/dev/null || echo unknown)"
    echo "=== END ==="
    exit 0
  fi

  echo "STEP: brew-install-colima"
  if ! command -v brew >/dev/null 2>&1; then
    echo "STATUS: failed"
    echo "ERROR: Homebrew not installed. Install brew first (https://brew.sh) then re-run."
    echo "=== END ==="
    exit 1
  fi

  # Formulae only — do not `brew install --cask docker`.
  brew install colima docker docker-compose
  ensure_compose_provider

  if ! command -v colima >/dev/null 2>&1; then
    echo "STATUS: failed"
    echo "ERROR: colima not found on PATH after brew install"
    echo "=== END ==="
    exit 1
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "STATUS: failed"
    echo "ERROR: docker CLI not found on PATH after brew install"
    echo "=== END ==="
    exit 1
  fi

  echo "STATUS: installed"
  echo "RUNTIME: colima"
  echo "COLIMA_VERSION: $(colima version 2>/dev/null | head -1 || echo unknown)"
  echo "DOCKER_VERSION: $(docker --version 2>/dev/null || echo unknown)"
  echo "=== END ==="
  exit 0
}

# ─── platform dispatch / already present ────────────────────────────────

case "$(uname -s)" in
  Darwin)
    install_or_reuse_macos
    ;;
esac

# Linux: already have docker CLI + podman → ensure sockets and exit.
if command -v docker >/dev/null 2>&1; then
  if command -v podman >/dev/null 2>&1; then
    enable_podman_sockets
    ensure_compose_provider
    echo "STATUS: already-installed"
    echo "RUNTIME: podman"
    echo "PODMAN_VERSION: $(podman --version 2>/dev/null || echo unknown)"
    echo "DOCKER_VERSION: $(docker --version 2>/dev/null || echo unknown)"
    echo "=== END ==="
    exit 0
  fi
  echo "STATUS: already-installed"
  echo "DOCKER_VERSION: $(docker --version 2>/dev/null || echo unknown)"
  echo "=== END ==="
  exit 0
fi

# Linux with Podman but missing docker shim — install shim only.
if command -v podman >/dev/null 2>&1; then
  echo "STEP: install-podman-docker-shim"
  if command -v apt-get >/dev/null 2>&1; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y podman-docker
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y podman-docker
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y podman-docker
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper --non-interactive install podman-docker
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm podman-docker
  fi
  if [ -d /etc/containers ]; then
    sudo touch /etc/containers/nodocker 2>/dev/null || true
  fi
  enable_podman_sockets
  ensure_compose_provider
  if command -v docker >/dev/null 2>&1; then
    echo "STATUS: installed"
    echo "RUNTIME: podman"
    echo "PODMAN_VERSION: $(podman --version 2>/dev/null || echo unknown)"
    echo "DOCKER_VERSION: $(docker --version 2>/dev/null || echo unknown)"
    echo "=== END ==="
    exit 0
  fi
fi

case "$(uname -s)" in
  Linux)
    install_linux_podman
    ;;
  *)
    echo "STATUS: failed"
    echo "ERROR: Unsupported platform: $(uname -s)"
    echo "=== END ==="
    exit 1
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "STATUS: failed"
  echo "ERROR: docker CLI shim not found on PATH after Podman install (expected podman-docker)"
  echo "=== END ==="
  exit 1
fi

echo "STATUS: installed"
echo "RUNTIME: podman"
echo "PODMAN_VERSION: $(podman --version 2>/dev/null || echo unknown)"
echo "DOCKER_VERSION: $(docker --version 2>/dev/null || echo unknown)"
echo "=== END ==="
