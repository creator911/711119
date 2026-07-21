#!/bin/sh
set -eu

data_dir=/var/lib/nara001
backup_root=/var/backups/nara001
timestamp=$(date +%Y%m%d-%H%M%S)
destination="$backup_root/$timestamp"

mkdir -p "$destination"
sqlite3 "$data_dir/nara001.sqlite" ".timeout 30000" ".backup '$destination/nara001.sqlite'"
if [ -d "$data_dir/media" ]; then
  tar -C "$data_dir" -czf "$destination/media.tar.gz" media
fi

find "$backup_root" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf -- {} +
