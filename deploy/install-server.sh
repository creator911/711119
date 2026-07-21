#!/bin/sh
set -eu

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl nginx sqlite3 tar xz-utils

if ! id -u nara001 >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/nara001 --shell /usr/sbin/nologin nara001
fi

install -d -o root -g root -m 0755 /opt/nara001 /etc/nara001
install -d -o nara001 -g nara001 -m 0750 /var/lib/nara001 /var/lib/nara001/media
install -d -o root -g root -m 0700 /var/backups/nara001

install -o root -g root -m 0644 deploy/nara001.service /etc/systemd/system/nara001.service
install -o root -g root -m 0644 deploy/nara001-backup.service /etc/systemd/system/nara001-backup.service
install -o root -g root -m 0644 deploy/nara001-backup.timer /etc/systemd/system/nara001-backup.timer
install -o root -g root -m 0755 deploy/backup.sh /usr/local/sbin/nara001-backup
install -o root -g root -m 0644 deploy/nginx.conf /etc/nginx/sites-available/nara001
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/nara001 /etc/nginx/sites-enabled/nara001

timedatectl set-timezone Asia/Seoul
nginx -t
systemctl daemon-reload
systemctl enable nginx nara001-backup.timer

if command -v ufw >/dev/null 2>&1; then
  ufw allow 'Nginx Full'
fi
