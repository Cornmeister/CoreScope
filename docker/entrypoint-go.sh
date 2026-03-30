#!/bin/sh

# Fix: Docker creates a directory when bind-mounting a non-existent file.
# If config.json is a directory (from a failed mount), remove it and use the example.
if [ -d /app/config.json ]; then
  echo "[entrypoint] WARNING: config.json is a directory (broken bind mount) — removing and using example"
  rm -rf /app/config.json
fi

# Copy example config if no config.json exists (not bind-mounted)
if [ ! -f /app/config.json ]; then
  echo "[entrypoint] No config.json found, copying from config.example.json"
  cp /app/config.example.json /app/config.json
fi

# theme.json: check data/ volume (admin-editable on host)
if [ -f /app/data/theme.json ]; then
  ln -sf /app/data/theme.json /app/theme.json
fi

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
