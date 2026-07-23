#!/bin/sh
set -eu

# Certbot replaces certificate files atomically, but the running Nginx
# workers keep the old certificate in memory until they are reloaded.
nginx -t
systemctl reload nginx
