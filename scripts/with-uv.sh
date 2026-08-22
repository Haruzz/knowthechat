#!/usr/bin/env sh

set -eu

UV_VERSION="0.12.5"
UV_BIN_DIR="${HOME}/.local/bin"
UV_BIN="${UV_BIN_DIR}/uv"

if command -v uv >/dev/null 2>&1; then
  exec uv "$@"
fi

if [ -x "${UV_BIN}" ]; then
  exec "${UV_BIN}" "$@"
fi

case "$(uname -s)" in
  Linux*)
    echo "uv ${UV_VERSION} is missing; installing it for this Linux build environment."
    curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" \
      | env UV_UNMANAGED_INSTALL="${UV_BIN_DIR}" sh
    exec "${UV_BIN}" "$@"
    ;;
  *)
    echo "uv is required but was not found on PATH." >&2
    echo "Install uv from https://docs.astral.sh/uv/getting-started/installation/ and retry." >&2
    exit 127
    ;;
esac
