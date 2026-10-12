#!/usr/bin/env bash
# Shared PATH / Docker-host helpers for setup (zclaw.sh, install-docker.sh,
# setup:auto).
#
#   macOS  — Homebrew on PATH, Colima DOCKER_HOST → ~/.colima/default/docker.sock
#   all    — ~/.local/bin on PATH (pnpm, onecli, zclaw)
#   Linux  — no brew / no Colima (Podman path unchanged)
#
# Source this file — do not execute it:
#   source "$PROJECT_ROOT/setup/lib/shell-path.sh"
#   nanoclaw_ensure_paths

# Append LINE to FILE when MARKER is not already present.
nanoclaw_append_profile_line() {
  local file=$1 marker=$2 line=$3
  local dir
  dir=$(dirname "$file")
  mkdir -p "$dir" 2>/dev/null || true
  touch "$file" 2>/dev/null || return 0
  if grep -qF "$marker" "$file" 2>/dev/null; then
    return 0
  fi
  # Prefer a blank line before our block when the file is non-empty.
  if [ -s "$file" ]; then
    printf '\n%s\n' "$line" >> "$file"
  else
    printf '%s\n' "$line" >> "$file"
  fi
}

nanoclaw_find_brew() {
  if command -v brew >/dev/null 2>&1; then
    command -v brew
    return 0
  fi
  if [ -x /opt/homebrew/bin/brew ]; then
    echo /opt/homebrew/bin/brew
    return 0
  fi
  if [ -x /usr/local/bin/brew ]; then
    echo /usr/local/bin/brew
    return 0
  fi
  return 1
}

# Put brew (and its prefix bin/) on PATH for this process.
nanoclaw_export_brew_path() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  local brew_bin
  brew_bin=$(nanoclaw_find_brew) || return 0
  # shellcheck disable=SC1090
  eval "$("$brew_bin" shellenv)"
}

# Persist brew shellenv into profiles so new terminals (login + interactive) see it.
nanoclaw_persist_brew_path() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  local brew_bin home
  brew_bin=$(nanoclaw_find_brew) || return 0
  home="${HOME:-}"
  [ -n "$home" ] || return 0

  local line marker
  line="eval \"\$($brew_bin shellenv)\""
  marker="brew shellenv"

  # .zprofile / .bash_profile: macOS login shells (Terminal.app default).
  # .zshrc / .bashrc: non-login interactive shells (many IDE terminals).
  for profile in \
    "$home/.zprofile" \
    "$home/.bash_profile" \
    "$home/.zshrc" \
    "$home/.bashrc"
  do
    nanoclaw_append_profile_line "$profile" "$marker" "$line"
  done
}

# Put ~/.local/bin first on PATH for this process (pnpm, onecli, zclaw, claude).
nanoclaw_export_local_bin_path() {
  local local_bin="${HOME:-}/.local/bin"
  [ -n "${HOME:-}" ] || return 0
  mkdir -p "$local_bin" 2>/dev/null || true
  case ":${PATH:-}:" in
    *":${local_bin}:"*) ;;
    *) export PATH="${local_bin}:${PATH:-}" ;;
  esac
}

nanoclaw_persist_local_bin_path() {
  local home="${HOME:-}"
  [ -n "$home" ] || return 0
  local line='export PATH="$HOME/.local/bin:$PATH"'
  local marker='.local/bin'
  for profile in \
    "$home/.zprofile" \
    "$home/.bash_profile" \
    "$home/.zshrc" \
    "$home/.bashrc"
  do
    nanoclaw_append_profile_line "$profile" "$marker" "$line"
  done
}

# True when macOS should use Colima (not Docker Desktop).
nanoclaw_macos_uses_colima() {
  [ "$(uname -s)" = "Darwin" ] || return 1
  if [ -d "/Applications/Docker.app" ] || [ -d "${HOME}/Applications/Docker.app" ]; then
    return 1
  fi
  command -v colima >/dev/null 2>&1
}

# Resolve Colima docker.sock (v0.4+ default profile). macOS / Colima only.
nanoclaw_colima_docker_sock() {
  nanoclaw_macos_uses_colima || return 1
  local home="${HOME:-}"
  [ -n "$home" ] || return 1

  local default_sock="${home}/.colima/default/docker.sock"
  if [ -S "$default_sock" ] || [ -e "$default_sock" ]; then
    echo "$default_sock"
    return 0
  fi

  # Live status: "socket: unix:///Users/…/.colima/default/docker.sock"
  if command -v colima >/dev/null 2>&1; then
    local status_line status_sock
    status_line=$(colima status 2>/dev/null | grep -i 'socket:' | head -1 || true)
    status_sock=$(printf '%s' "$status_line" | sed -E 's/.*socket:[[:space:]]*//;s/[[:space:]]*$//')
    if [[ "$status_sock" == unix:///* ]]; then
      echo "${status_sock#unix://}"
      return 0
    fi
  fi

  # Expected path before first `colima start` creates the socket.
  echo "$default_sock"
  return 0
}

# Point DOCKER_HOST at Colima's default-profile socket and select the
# `colima` Docker context. Fixes mis-set hosts like
# unix://…/.colima/docker/docker.sock (wrong profile name).
# No-op on Linux/WSL and when Docker Desktop is present.
nanoclaw_ensure_colima_docker_host() {
  nanoclaw_macos_uses_colima || return 0

  local sock
  sock=$(nanoclaw_colima_docker_sock) || return 0
  export DOCKER_HOST="unix://${sock}"

  if command -v docker >/dev/null 2>&1; then
    docker context use colima >/dev/null 2>&1 || true
  fi

  local home="${HOME:-}"
  [ -n "$home" ] || return 0
  # Persist the stable default-profile path (NanoClaw always `colima start`
  # without --profile). Marker keeps re-runs idempotent.
  local line
  line="# NANOCLAW_COLIMA_DOCKER_HOST"$'\n'"export DOCKER_HOST=\"unix://\${HOME}/.colima/default/docker.sock\""
  for profile in \
    "$home/.zprofile" \
    "$home/.bash_profile" \
    "$home/.zshrc" \
    "$home/.bashrc"
  do
    nanoclaw_append_profile_line "$profile" "NANOCLAW_COLIMA_DOCKER_HOST" "$line"
  done
}

# Session + profiles.
nanoclaw_ensure_paths() {
  # macOS-only: Homebrew. Linux/WSL never touch brew.
  nanoclaw_export_brew_path
  nanoclaw_persist_brew_path
  # All platforms: ~/.local/bin (pnpm / onecli / zclaw).
  nanoclaw_export_local_bin_path
  nanoclaw_persist_local_bin_path
  # macOS + Colima only (skipped on Linux / Docker Desktop).
  nanoclaw_ensure_colima_docker_host
}

# Write a sourcable snippet (for manuals / recovery). Overwrites each run.
nanoclaw_write_path_exports_file() {
  local dest=$1
  mkdir -p "$(dirname "$dest")" 2>/dev/null || true
  {
    echo "# Generated by NanoClaw setup — source this to refresh PATH in the current shell."
    echo "#   source \"$dest\""
    if [ "$(uname -s)" = "Darwin" ]; then
      local brew_bin=""
      brew_bin=$(nanoclaw_find_brew 2>/dev/null || true)
      if [ -n "$brew_bin" ]; then
        echo "eval \"\$($brew_bin shellenv)\""
      else
        echo 'if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi'
        echo 'if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi'
      fi
      if nanoclaw_macos_uses_colima 2>/dev/null; then
        echo 'export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"'
      fi
    fi
    echo 'export PATH="$HOME/.local/bin:$PATH"'
  } > "$dest"
}

# After successful setup under `bash zclaw.sh`, replace this process with an
# interactive shell that inherits the updated PATH (same terminal window).
# Parent shells that invoked us are unchanged; open a new tab or exit this
# handoff shell to return to them.
#
# Skip with NANOCLAW_SKIP_SHELL_HANDOFF=1 (CI / scripted runs).
nanoclaw_handoff_interactive_shell() {
  local project_root=${1:-}
  if [ -n "${NANOCLAW_SKIP_SHELL_HANDOFF:-}" ]; then
    return 0
  fi
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    return 0
  fi
  # Re-apply in case profiles were written but this process missed an export.
  nanoclaw_ensure_paths
  if [ -n "$project_root" ] && [ -d "$project_root" ]; then
    cd "$project_root" || true
  fi
  local shell=${SHELL:-/bin/zsh}
  if [ ! -x "$shell" ]; then
    shell=/bin/bash
  fi
  if [ "$(uname -s)" = "Darwin" ]; then
    printf '\n  %s\n' "Refreshing this terminal so brew, docker, and zclaw are on PATH…"
  else
    printf '\n  %s\n' "Refreshing this terminal so zclaw and ~/.local/bin are on PATH…"
  fi
  printf '  %s\n\n' "(Open a new terminal anytime — the same PATH is in your shell profile.)"
  exec "$shell" -i
}
