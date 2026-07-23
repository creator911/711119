# nara001 production bootstrap and release flow

These steps are intentionally split into infrastructure installation and an
atomic release activation. `install-server.sh` never creates an application
release or a secret file. It starts `nara001.service` only after the current
release, production build, dependencies, secrets, and writable data paths all
pass validation.

## 1. First-server infrastructure

Run from the repository root as root:

```sh
sh deploy/install-node.sh
LETSENCRYPT_EMAIL=ops@example.com sh deploy/install-server.sh
```

On a new server this installs nginx, TLS, Cloudflare-origin restrictions,
backup/allowlist timers, and systemd units. With no release or environment file
yet, the script exits successfully but clearly reports that the application was
not enabled. Existing active services are not stopped or disabled.

Before requesting the certificate, point both `nara001.co.kr` and
`www.nara001.co.kr` at the origin and make the ACME challenge reachable. After
certificate issuance, keep the public site proxied by Cloudflare; nginx and UFW
restrict normal HTTP(S) traffic to Cloudflare ranges.

## 2. Secret and data configuration

```sh
install -o root -g nara001 -m 0640 deploy/nara001.env.example /etc/nara001/nara001.env
editor /etc/nara001/nara001.env
```

Replace both placeholder secrets with independent random values of at least 32
characters. Keep the data, database, and media paths under `/var/lib/nara001`;
the hardened systemd service cannot write elsewhere.

## 3. Build an immutable release

Build in a new directory instead of changing `/opt/nara001/current` in place:

```sh
release=/opt/nara001/releases/$(date -u +%Y%m%dT%H%M%SZ)
install -d -o nara001 -g nara001 -m 0755 "$release"
# Copy the checked-out 711119 repository into $release without .git or local data.
cd "$release"
sudo -u nara001 /usr/local/bin/npm ci
sudo -u nara001 /usr/local/bin/npm run build
test -f dist/server/index.js
test -d dist/client
```

Do not copy `.nara-data`, a SQLite database, uploaded media, `.env` files, or
another site's release into this directory.

## 4. Activate, validate, and roll back safely

Record the previous target, switch the symlink atomically, and ask the installer
to perform a strict prerequisite check:

```sh
previous=$(readlink -f /opt/nara001/current 2>/dev/null || true)
ln -sfn "$release" /opt/nara001/current.next
mv -Tf /opt/nara001/current.next /opt/nara001/current
cd "$release"
NARA001_REQUIRE_APP_START=1 NARA001_RESTART_APP=1 sh deploy/install-server.sh
systemctl status --no-pager nara001.service
curl --fail --max-time 10 http://127.0.0.1:3000/
```

The service applies pending migrations before starting. If activation fails,
restore the prior immutable release and restart; do not roll back the database
file or edit an applied migration:

```sh
if [ -n "$previous" ]; then
  ln -sfn "$previous" /opt/nara001/current.next
  mv -Tf /opt/nara001/current.next /opt/nara001/current
  systemctl restart nara001.service
fi
```

Keep release directories until the new version and a restore test have passed.
Database/media backups currently live on the same machine; production requires
an encrypted off-server copy plus a regularly tested restore procedure. Add a
root-owned executable to `/etc/nara001/backup-hooks.d`; it receives the completed
backup directory (including `SHA256SUMS`) as its only argument. Put optional
non-secret settings such as `NARA_BACKUP_HOOK_DIR` in `/etc/nara001/backup.env`.
Keep object-storage credentials in a root-readable credential file used by the
hook, not in the repository. Hook failures make the systemd backup job fail so
they can be alerted on.
