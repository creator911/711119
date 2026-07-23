#!/bin/sh
set -eu

TARGET=/etc/nginx/snippets/nara001-cloudflare-allow.conf
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT HUP INT TERM

curl -fsS --retry 3 --connect-timeout 10 --max-time 30 https://www.cloudflare.com/ips-v4 -o "$WORK_DIR/ips-v4"
curl -fsS --retry 3 --connect-timeout 10 --max-time 30 https://www.cloudflare.com/ips-v6 -o "$WORK_DIR/ips-v6"

V4_COUNT=$(grep -Ec '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' "$WORK_DIR/ips-v4" || true)
V6_COUNT=$(grep -Ec '^[0-9A-Fa-f:]+/[0-9]{1,3}$' "$WORK_DIR/ips-v6" || true)
TOTAL_V4=$(grep -Ec '.+' "$WORK_DIR/ips-v4" || true)
TOTAL_V6=$(grep -Ec '.+' "$WORK_DIR/ips-v6" || true)

if [ "$V4_COUNT" -lt 10 ] || [ "$V6_COUNT" -lt 5 ] || [ "$V4_COUNT" -ne "$TOTAL_V4" ] || [ "$V6_COUNT" -ne "$TOTAL_V6" ]; then
  echo "Cloudflare IP range response failed validation; keeping the current allowlist." >&2
  exit 1
fi

{
  echo "# Generated from Cloudflare's official IP range endpoints."
  sed 's/^/allow /; s/$/;/' "$WORK_DIR/ips-v4"
  sed 's/^/allow /; s/$/;/' "$WORK_DIR/ips-v6"
  echo "deny all;"
} > "$WORK_DIR/allow.conf"

install -d -o root -g root -m 0755 /etc/nginx/snippets
if [ -f "$TARGET" ]; then
  cp "$TARGET" "$WORK_DIR/previous.conf"
fi
install -o root -g root -m 0644 "$WORK_DIR/allow.conf" "$TARGET"

if ! nginx -t; then
  if [ -f "$WORK_DIR/previous.conf" ]; then
    install -o root -g root -m 0644 "$WORK_DIR/previous.conf" "$TARGET"
  fi
  echo "Updated allowlist failed nginx validation; restored the previous file." >&2
  exit 1
fi

if command -v ufw >/dev/null 2>&1; then
  # General deny rules must remain after every Cloudflare allow rule. Remove
  # and append them again so newly published Cloudflare ranges are reachable.
  ufw --force delete deny 80/tcp >/dev/null 2>&1 || true
  ufw --force delete deny 443/tcp >/dev/null 2>&1 || true
  sed -n 's/^allow \([^;]*\);$/\1/p' "$TARGET" | while IFS= read -r cidr; do
    ufw allow proto tcp from "$cidr" to any port 80 >/dev/null || true
    ufw allow proto tcp from "$cidr" to any port 443 >/dev/null || true
  done
  # Remove ranges Cloudflare no longer publishes. Keeping retired provider
  # ranges in UFW would gradually reopen the origin to future range owners.
  if [ -f "$WORK_DIR/previous.conf" ]; then
    sed -n 's/^allow \([^;]*\);$/\1/p' "$WORK_DIR/previous.conf" | while IFS= read -r cidr; do
      if ! grep -Fqx "allow $cidr;" "$TARGET"; then
        ufw --force delete allow proto tcp from "$cidr" to any port 80 >/dev/null 2>&1 || true
        ufw --force delete allow proto tcp from "$cidr" to any port 443 >/dev/null 2>&1 || true
      fi
    done
  fi
  ufw deny 80/tcp >/dev/null || true
  ufw deny 443/tcp >/dev/null || true
fi

systemctl reload nginx
