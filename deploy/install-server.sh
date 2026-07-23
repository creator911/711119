#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install-server.sh must be run as root." >&2
  exit 1
fi

for required_file in deploy/nara001.service deploy/nginx.conf deploy/nginx-bootstrap.conf; do
  if [ ! -f "$required_file" ]; then
    echo "Run install-server.sh from the repository root (missing $required_file)." >&2
    exit 1
  fi
done

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates certbot curl nginx sqlite3 tar xz-utils

if ! id -u nara001 >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/nara001 --shell /usr/sbin/nologin nara001
fi

install -d -o root -g root -m 0755 /opt/nara001 /etc/nara001
install -d -o root -g root -m 0750 /etc/nara001/backup-hooks.d
install -d -o nara001 -g nara001 -m 0750 /var/lib/nara001 /var/lib/nara001/media
install -d -o root -g root -m 0700 /var/backups/nara001
install -d -o root -g root -m 0755 /var/www/letsencrypt /etc/nginx/snippets
install -d -o www-data -g www-data -m 0750 /var/cache/nginx /var/cache/nginx/nara-announcements /var/cache/nginx/nara-public

install -o root -g root -m 0644 deploy/nara001.service /etc/systemd/system/nara001.service
install -o root -g root -m 0644 deploy/nara001-backup.service /etc/systemd/system/nara001-backup.service
install -o root -g root -m 0644 deploy/nara001-backup.timer /etc/systemd/system/nara001-backup.timer
install -o root -g root -m 0644 deploy/nara001-event-settlement.service /etc/systemd/system/nara001-event-settlement.service
install -o root -g root -m 0644 deploy/nara001-event-settlement.timer /etc/systemd/system/nara001-event-settlement.timer
install -o root -g root -m 0755 deploy/backup.sh /usr/local/sbin/nara001-backup
install -o root -g root -m 0755 deploy/refresh-cloudflare-allowlist.sh /usr/local/sbin/nara001-refresh-cloudflare-allowlist
install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy
install -o root -g root -m 0755 deploy/certbot-reload-nginx.sh /etc/letsencrypt/renewal-hooks/deploy/nara001-reload-nginx
install -o root -g root -m 0644 deploy/nara001-cloudflare-allowlist.service /etc/systemd/system/nara001-cloudflare-allowlist.service
install -o root -g root -m 0644 deploy/nara001-cloudflare-allowlist.timer /etc/systemd/system/nara001-cloudflare-allowlist.timer
install -o root -g root -m 0644 deploy/cloudflare-origin-allow.conf /etc/nginx/snippets/nara001-cloudflare-allow.conf
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/nara001 /etc/nginx/sites-enabled/nara001

timedatectl set-timezone Asia/Seoul
systemctl daemon-reload

if [ ! -s /etc/letsencrypt/live/nara001.co.kr/fullchain.pem ] || [ ! -s /etc/letsencrypt/live/nara001.co.kr/privkey.pem ]; then
  install -o root -g root -m 0644 deploy/nginx-bootstrap.conf /etc/nginx/sites-available/nara001
  nginx -t
  systemctl enable --now nginx

  if [ -n "${LETSENCRYPT_EMAIL:-}" ]; then
    CERTBOT_CONTACT="--email $LETSENCRYPT_EMAIL"
  else
    CERTBOT_CONTACT="--register-unsafely-without-email"
  fi
  # shellcheck disable=SC2086
  certbot certonly --webroot --webroot-path /var/www/letsencrypt \
    --non-interactive --agree-tos $CERTBOT_CONTACT \
    --cert-name nara001.co.kr -d nara001.co.kr -d www.nara001.co.kr
fi

install -o root -g root -m 0644 deploy/nginx.conf /etc/nginx/sites-available/nara001
nginx -t
systemctl enable --now nginx nara001-backup.timer nara001-cloudflare-allowlist.timer
if systemctl list-unit-files certbot.timer >/dev/null 2>&1; then
  systemctl enable --now certbot.timer
fi

systemctl reload nginx

if command -v ufw >/dev/null 2>&1; then
  # Preserve SSH and other existing firewall rules, but only permit web traffic
  # from the same Cloudflare ranges that nginx trusts.
  ufw --force delete deny 80/tcp >/dev/null 2>&1 || true
  ufw --force delete deny 443/tcp >/dev/null 2>&1 || true
  sed -n 's/^allow \([^;]*\);$/\1/p' /etc/nginx/snippets/nara001-cloudflare-allow.conf | while IFS= read -r cidr; do
    ufw allow proto tcp from "$cidr" to any port 80 >/dev/null || true
    ufw allow proto tcp from "$cidr" to any port 443 >/dev/null || true
  done
  ufw --force delete allow 'Nginx Full' >/dev/null 2>&1 || true
  ufw deny 80/tcp >/dev/null || true
  ufw deny 443/tcp >/dev/null || true
fi

APP_CURRENT=/opt/nara001/current
APP_ENV=/etc/nara001/nara001.env
APP_PROBLEMS=""
add_app_problem() {
  if [ -n "$APP_PROBLEMS" ]; then APP_PROBLEMS="$APP_PROBLEMS; $1"; else APP_PROBLEMS="$1"; fi
}

[ -x /usr/local/bin/node ] || add_app_problem "/usr/local/bin/node is missing (run deploy/install-node.sh)"
[ -x /usr/local/bin/npm ] || add_app_problem "/usr/local/bin/npm is missing (run deploy/install-node.sh)"
[ -d "$APP_CURRENT" ] || add_app_problem "$APP_CURRENT is missing"
[ -f "$APP_CURRENT/package.json" ] || add_app_problem "$APP_CURRENT/package.json is missing"
[ -f "$APP_CURRENT/server/start.mjs" ] || add_app_problem "$APP_CURRENT/server/start.mjs is missing"
[ -f "$APP_CURRENT/server/migrate.mjs" ] || add_app_problem "$APP_CURRENT/server/migrate.mjs is missing"
[ -f "$APP_CURRENT/node_modules/vinext/dist/cli.js" ] || add_app_problem "production node_modules are missing"
[ -f "$APP_CURRENT/dist/server/index.js" ] || add_app_problem "production build output is missing"
[ -d "$APP_CURRENT/dist/client" ] || add_app_problem "client build output is missing"
[ -f "$APP_ENV" ] || add_app_problem "$APP_ENV is missing"

if [ -f "$APP_ENV" ]; then
  grep -Eq '^ADMIN_SESSION_SECRET=.{32,}$' "$APP_ENV" || add_app_problem "ADMIN_SESSION_SECRET must contain at least 32 characters"
  grep -Eq '^CAPTCHA_SECRET=.{32,}$' "$APP_ENV" || add_app_problem "CAPTCHA_SECRET must contain at least 32 characters"
  grep -Eq '^NARA_DATA_DIR=/var/lib/nara001(/.*)?$' "$APP_ENV" || add_app_problem "NARA_DATA_DIR must be inside /var/lib/nara001"
  grep -Eq '^NARA_DB_PATH=/var/lib/nara001/.+$' "$APP_ENV" || add_app_problem "NARA_DB_PATH must be inside /var/lib/nara001"
  grep -Eq '^NARA_MEDIA_DIR=/var/lib/nara001(/.*)?$' "$APP_ENV" || add_app_problem "NARA_MEDIA_DIR must be inside /var/lib/nara001"
fi

if [ -z "$APP_PROBLEMS" ]; then
  if ! runuser -u nara001 -- test -r "$APP_CURRENT/package.json" || ! runuser -u nara001 -- test -r "$APP_ENV"; then
    add_app_problem "release or environment file is not readable by the nara001 service account"
  fi
fi

if [ -z "$APP_PROBLEMS" ]; then
  systemctl enable nara001.service nara001-event-settlement.timer
  if systemctl is-active --quiet nara001.service; then
    if [ "${NARA001_RESTART_APP:-0}" = "1" ]; then
      systemctl restart nara001.service
      echo "nara001 application prerequisites verified; active service was restarted onto the current release."
    else
      echo "nara001 application prerequisites verified; existing active service was left running (set NARA001_RESTART_APP=1 to activate a new release)."
    fi
  else
    systemctl start nara001.service
    echo "nara001 application prerequisites verified; service was started."
  fi
  systemctl start nara001-event-settlement.timer
else
  echo "nara001 application was not enabled or started: $APP_PROBLEMS" >&2
  echo "Complete deploy/README.md, then rerun with NARA001_REQUIRE_APP_START=1 for a strict readiness check." >&2
  if [ "${NARA001_REQUIRE_APP_START:-0}" = "1" ]; then
    exit 1
  fi
fi
