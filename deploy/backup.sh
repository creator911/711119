#!/bin/sh
set -eu

data_dir=/var/lib/nara001
backup_root=/var/backups/nara001
hook_dir=${NARA_BACKUP_HOOK_DIR:-/etc/nara001/backup-hooks.d}
timestamp=$(date +%Y%m%d-%H%M%S)
destination="$backup_root/$timestamp"

mkdir -p "$destination"
sqlite3 "$data_dir/nara001.sqlite" ".timeout 30000" ".backup '$destination/nara001.sqlite'"
if [ -d "$data_dir/media" ]; then
  tar -C "$data_dir" -czf "$destination/media.tar.gz" media
fi

(
  cd "$destination"
  sha256sum nara001.sqlite media.tar.gz 2>/dev/null > SHA256SUMS || sha256sum nara001.sqlite > SHA256SUMS
)

# Optional root-owned executable hooks can copy the completed, checksummed
# snapshot to object storage or another host. A failing hook fails the systemd
# job so monitoring can alert instead of silently claiming an off-site backup.
if [ -d "$hook_dir" ]; then
  for hook in "$hook_dir"/*; do
    [ -f "$hook" ] && [ -x "$hook" ] || continue
    "$hook" "$destination"
  done
fi

find "$backup_root" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf -- {} +
