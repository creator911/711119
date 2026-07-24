import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("nginx blocks direct origin traffic and only trusts Cloudflare at the app vhost", () => {
  const nginx = read("deploy/nginx.conf");
  const allowlist = read("deploy/cloudflare-origin-allow.conf");
  assert.doesNotMatch(nginx, /server_name\s+158\.247\.238\.199/);
  assert.match(nginx, /listen 80 default_server;[\s\S]*?return 444;/);
  assert.match(
    nginx,
    /listen 443 ssl default_server;[\s\S]*?server_name _;[\s\S]*?ssl_certificate \/etc\/letsencrypt\/live\/nara001\.co\.kr\/fullchain\.pem;[\s\S]*?ssl_certificate_key \/etc\/letsencrypt\/live\/nara001\.co\.kr\/privkey\.pem;[\s\S]*?return 444;/,
  );
  assert.equal((nginx.match(/nara001-cloudflare-allow\.conf/g) ?? []).length, 2);
  assert.match(allowlist, /allow 173\.245\.48\.0\/20;/);
  assert.match(allowlist, /allow 2a06:98c0::\/29;/);
  assert.match(allowlist, /deny all;\s*$/);
  assert.match(nginx, /proxy_set_header X-Real-IP \$http_cf_connecting_ip;/);
});

test("split services trust one normalized reverse-proxy protocol header", () => {
  const publicEnv = read("deploy/public.env.example");
  const adminEnv = read("deploy/admin.env.example");
  const nginx = read("deploy/nginx-split.conf.template");
  assert.match(publicEnv, /^VINEXT_TRUST_PROXY=1$/m);
  assert.match(adminEnv, /^VINEXT_TRUST_PROXY=1$/m);
  assert.doesNotMatch(
    nginx,
    /include \/etc\/nginx\/proxy_params;[\s\S]{0,180}?proxy_set_header X-Forwarded-Proto/,
    "proxy_params already supplies X-Forwarded-Proto; a duplicate becomes a comma-separated value",
  );
});

test("the isolated worker does not depend on a public service unit on the admin host", () => {
  const worker = read("deploy/nara001-worker.service");
  assert.match(worker, /^After=network-online\.target valkey\.service$/m);
  assert.doesNotMatch(worker, /nara001-public\.service/);
});

test("fresh server install bootstraps TLS before installing the SSL vhost", () => {
  const install = read("deploy/install-server.sh");
  const bootstrap = read("deploy/nginx-bootstrap.conf");
  const refresh = read("deploy/refresh-cloudflare-allowlist.sh");
  assert.match(install, /deploy\/nginx-bootstrap\.conf/);
  assert.match(install, /certbot certonly --webroot/);
  assert.match(install, /renewal-hooks\/deploy\/nara001-reload-nginx/);
  assert.match(install, /systemctl enable --now certbot\.timer/);
  const renewalHook = read("deploy/certbot-reload-nginx.sh");
  assert.match(renewalHook, /nginx -t/);
  assert.match(renewalHook, /systemctl reload nginx/);
  assert.ok(install.indexOf("deploy/nginx-bootstrap.conf") < install.indexOf("deploy/nginx.conf /etc/nginx/sites-available/nara001"));
  assert.doesNotMatch(bootstrap, /listen 443/);
  assert.match(bootstrap, /\.well-known\/acme-challenge/);
  assert.ok(refresh.lastIndexOf("ufw deny 80/tcp") > refresh.indexOf('ufw allow proto tcp from "$cidr" to any port 80'));
  assert.ok(refresh.lastIndexOf("ufw deny 443/tcp") > refresh.indexOf('ufw allow proto tcp from "$cidr" to any port 443'));
  assert.match(refresh, /previous\.conf[\s\S]*grep -Fqx "allow \$cidr;"[\s\S]*ufw --force delete allow proto tcp from "\$cidr"/);
  assert.equal((refresh.match(/--max-time 30/g) ?? []).length, 2);
});

test("nginx microcaches only the public active-announcement metadata endpoint", () => {
  const nginx = read("deploy/nginx.conf");
  assert.match(nginx, /proxy_cache_path \/var\/cache\/nginx\/nara-announcements[\s\S]*?keys_zone=nara_announcements:10m/);
  const location = nginx.match(/location = \/api\/announcements\/active \{([\s\S]*?)\n    \}/)?.[1] ?? "";
  assert.ok(location, "exact active-announcement location must exist");
  assert.match(location, /proxy_set_header Cookie "";/);
  assert.match(location, /proxy_cache nara_announcements;/);
  assert.match(location, /proxy_cache_key "\$scheme\|\$request_method\|\$host\|\$uri";/);
  assert.match(location, /proxy_cache_methods GET HEAD;/);
  assert.match(location, /proxy_cache_valid 200 10s;/);
  assert.match(location, /proxy_cache_valid 304 10s;/);
  assert.match(location, /proxy_cache_revalidate on;/);
  assert.match(location, /proxy_cache_lock on;/);
  assert.match(location, /proxy_hide_header Set-Cookie;/);
  assert.doesNotMatch(location, /add_header/, "location must inherit the server security headers");
  assert.doesNotMatch(location, /\$args|\$cookie|proxy_cache_bypass/);
  const install = read("deploy/install-server.sh");
  assert.match(install, /install -d -o www-data -g www-data -m 0750 \/var\/cache\/nginx \/var\/cache\/nginx\/nara-announcements/);
});

test("nginx microcaches only explicitly listed cookie-free public GET endpoints", () => {
  const nginx = read("deploy/nginx.conf");
  assert.match(nginx, /proxy_cache_path \/var\/cache\/nginx\/nara-public[\s\S]*?keys_zone=nara_public:20m/);
  assert.match(nginx, /map "\$http_cookie\|\$http_authorization" \$nara_public_cache_bypass \{[\s\S]*?"\|"\s+0;[\s\S]*?default 1;/);
  const location = nginx.match(/location ~ \^\/api\/\(\?:posts\|featured-vendors\|vendor-posts\|events\/leaderboard\)\$ \{([\s\S]*?)\n    \}/)?.[1] ?? "";
  assert.ok(location, "the anonymous public endpoint allowlist must remain explicit");
  assert.match(location, /proxy_cache nara_public;/);
  assert.match(location, /proxy_cache_methods GET HEAD;/);
  assert.match(location, /proxy_cache_valid 200 5s;/);
  assert.match(location, /proxy_cache_bypass \$nara_public_cache_bypass;/);
  assert.match(location, /proxy_no_cache \$nara_public_cache_bypass \$upstream_http_set_cookie;/);
  assert.match(location, /proxy_ignore_headers Cache-Control Expires;/);
  assert.doesNotMatch(location, /proxy_hide_header Set-Cookie/);
  assert.doesNotMatch(location, /\/api\/posts\//, "post details are personalized and must never enter the list cache");
});

test("server installer starts the application only after release and secret readiness checks", () => {
  const install = read("deploy/install-server.sh");
  const documentation = read("deploy/README.md");
  assert.match(install, /APP_CURRENT=\/opt\/nara001\/current/);
  assert.match(install, /ADMIN_SESSION_SECRET must contain at least 32 characters/);
  assert.match(install, /CAPTCHA_SECRET must contain at least 32 characters/);
  assert.match(install, /dist\/server\/index\.js/);
  assert.match(install, /runuser -u nara001 -- test -r/);
  assert.match(install, /if \[ -z "\$APP_PROBLEMS" \]; then\s+systemctl enable nara001\.service nara001-event-settlement\.timer/);
  assert.match(install, /NARA001_RESTART_APP/);
  assert.match(install, /systemctl restart nara001\.service/);
  assert.match(install, /NARA001_REQUIRE_APP_START/);
  assert.ok(install.indexOf("systemctl reload nginx") < install.indexOf("APP_CURRENT=/opt/nara001/current"), "strict app failure must not skip nginx activation");
  assert.doesNotMatch(install, /install[^\n]*nara001\.env\.example[^\n]*\/etc\/nara001/, "the installer must never overwrite production secrets");
  assert.match(documentation, /immutable release/i);
  assert.match(documentation, /restore the prior immutable release/i);
  assert.match(documentation, /encrypted off-server copy/i);
});

test("backups are checksummed before optional off-server hooks run", () => {
  const backup = read("deploy/backup.sh");
  const service = read("deploy/nara001-backup.service");
  assert.match(backup, /sha256sum nara001\.sqlite/);
  assert.ok(backup.indexOf("SHA256SUMS") < backup.indexOf('"$hook" "$destination"'));
  assert.match(backup, /NARA_BACKUP_HOOK_DIR:-\/etc\/nara001\/backup-hooks\.d/);
  assert.match(service, /EnvironmentFile=-\/etc\/nara001\/backup\.env/);
});
