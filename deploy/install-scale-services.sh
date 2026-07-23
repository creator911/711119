#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install-scale-services.sh must be run as root." >&2
  exit 1
fi

cd "$(dirname "$0")/.."
for file in \
  deploy/nara001-public.service \
  deploy/nara001-admin.service \
  deploy/nara001-worker.service \
  deploy/logrotate-nara001
do
  [ -f "$file" ] || { echo "Missing $file" >&2; exit 1; }
done

id -u nara001 >/dev/null 2>&1 || {
  echo "Create the nara001 service account with deploy/install-server.sh first." >&2
  exit 1
}

install -d -o root -g nara001 -m 0750 /etc/nara001
install -d -o www-data -g www-data -m 0750 \
  /var/cache/nginx/nara-announcements /var/cache/nginx/nara-public
install -o root -g root -m 0644 deploy/nara001-public.service /etc/systemd/system/nara001-public.service
install -o root -g root -m 0644 deploy/nara001-admin.service /etc/systemd/system/nara001-admin.service
install -o root -g root -m 0644 deploy/nara001-worker.service /etc/systemd/system/nara001-worker.service
install -o root -g root -m 0644 deploy/logrotate-nara001 /etc/logrotate.d/nara001

for environment in shared public admin worker; do
  target="/etc/nara001/${environment}.env"
  example="deploy/${environment}.env.example"
  if [ ! -f "$target" ]; then
    install -o root -g nara001 -m 0640 "$example" "$target"
    echo "Created $target from its placeholder example; replace every placeholder before starting services."
  fi
done

systemctl daemon-reload
systemctl enable nara001-public.service nara001-admin.service nara001-worker.service
echo "Scale service units installed but not started. Complete env files, PostgreSQL/R2 migration, and nginx rendering first."
