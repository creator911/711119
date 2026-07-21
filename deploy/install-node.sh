#!/bin/sh
set -eu

version=${NODE_VERSION:-24.16.0}
machine=$(uname -m)
case "$machine" in
  x86_64|amd64) architecture=x64 ;;
  aarch64|arm64) architecture=arm64 ;;
  *) echo "Unsupported machine architecture: $machine" >&2; exit 1 ;;
esac

archive="node-v${version}-linux-${architecture}.tar.xz"
base_url="https://nodejs.org/dist/v${version}"
temporary_directory=$(mktemp -d)
trap 'rm -rf -- "$temporary_directory"' EXIT

cd "$temporary_directory"
curl --fail --silent --show-error --location --remote-name "$base_url/$archive"
curl --fail --silent --show-error --location --remote-name "$base_url/SHASUMS256.txt"
grep "  $archive\$" SHASUMS256.txt | sha256sum --check --strict -

install_root=/usr/local/lib/nodejs
release_directory="$install_root/node-v${version}-linux-${architecture}"
mkdir -p "$install_root"
rm -rf -- "$release_directory"
tar -xJf "$archive" -C "$install_root"

ln -sfn "$release_directory/bin/node" /usr/local/bin/node
ln -sfn "$release_directory/bin/npm" /usr/local/bin/npm
ln -sfn "$release_directory/bin/npx" /usr/local/bin/npx
ln -sfn "$release_directory/bin/corepack" /usr/local/bin/corepack

/usr/local/bin/node --version
/usr/local/bin/npm --version
