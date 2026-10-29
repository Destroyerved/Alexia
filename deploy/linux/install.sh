#!/usr/bin/env bash
#
# Installs (or upgrades) the Alexia DevSecOps Guardian platform on a Linux server as a systemd service.
#
#   sudo ./deploy/linux/install.sh                  from an unzipped alexia-server-<version>.zip, or
#   sudo ./deploy/linux/install.sh /path/to/Alexia  from a repository checkout
#
# Tested on Ubuntu Server 22.04 / 24.04 and Debian 12. Safe to run again: an upgrade replaces
# the program in /opt/alexia and leaves the data, backups and settings untouched.
#
#   /opt/alexia             the program — replaced on every upgrade
#   /var/lib/alexia         SQLite database (alexia.db), evidence, and snapshots
#   /var/backups/alexia     nightly copies of the database
#   /etc/alexia/alexia.env  settings; created once, never overwritten
set -euo pipefail

APP_DIR=/opt/alexia
DATA_DIR=/var/lib/alexia
BACKUP_DIR=${ALEXIA_BACKUP_DIR:-/var/backups/alexia}
ENV_DIR=/etc/alexia
ENV_FILE=$ENV_DIR/alexia.env
SERVICE=/etc/systemd/system/alexia.service

say()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo."

SRC=${1:-}
if [ -z "$SRC" ]; then
  here=$(cd "$(dirname "$0")" && pwd)
  for candidate in "$here" "$here/../.."; do
    if [ -f "$candidate/launcher.py" ] && [ -d "$candidate/alexia" ]; then
      SRC=$(cd "$candidate" && pwd)
      break
    fi
  done
fi
[ -n "$SRC" ] && [ -f "$SRC/launcher.py" ] || die "Could not find the Alexia server files. Pass the folder: sudo ./install.sh /path/to/Alexia"
VERSION=$(grep -m1 '"version"' "$SRC/package.json" 2>/dev/null | sed -E 's/.*"([0-9][^"]*)".*/\1/' || echo "1.0.0")
say "Installing Alexia DevSecOps Guardian $VERSION from $SRC"

# ---------------------------------------------------------------- Python 3 + venv
if ! command -v python3 >/dev/null 2>&1; then
  say "Installing Python 3"
  apt-get update -y
  apt-get install -y python3 python3-venv python3-pip curl ca-certificates
fi

# ---------------------------------------------------------------- user and folders
id alexia >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin alexia
mkdir -p "$APP_DIR" "$DATA_DIR" "$DATA_DIR/evidence" "$DATA_DIR/snapshots" "$BACKUP_DIR" "$ENV_DIR"
chown -R alexia:alexia "$DATA_DIR" "$BACKUP_DIR"
chmod 750 "$DATA_DIR" "$BACKUP_DIR"

# ---------------------------------------------------------------- settings (first install only)
if [ ! -f "$ENV_FILE" ]; then
  say "Writing $ENV_FILE"
  ADMIN_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)
  JWT_SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\n')
  cat > "$ENV_FILE" <<EOF
# Alexia DevSecOps Guardian settings.
# After editing:  sudo systemctl restart alexia
PORT=8080
HOST=0.0.0.0
ALEXIA_DATA_DIR=$DATA_DIR
ALEXIA_BACKUP_DIR=$BACKUP_DIR
ALEXIA_BACKUP_KEEP=30
ALEXIA_JWT_SECRET=$JWT_SECRET
ALEXIA_ADMIN_EMAIL=admin@alexia.local
ALEXIA_ADMIN_PASSWORD=$ADMIN_PASSWORD
NEBIUS_API_KEY=
NEBIUS_BASE_URL=https://api.studio.nebius.ai/v1
TAVILY_API_KEY=
DAILY_USD_BUDGET=10.00
DAILY_TOKEN_BUDGET=5000000
EOF
  chmod 640 "$ENV_FILE"
  chown root:alexia "$ENV_FILE"
  FIRST_INSTALL=1
else
  say "Keeping existing settings in $ENV_FILE"
  FIRST_INSTALL=0
fi

# ---------------------------------------------------------------- the program
say "Copying the program to $APP_DIR"
systemctl stop alexia 2>/dev/null || true
find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name .venv -exec rm -rf {} +
for item in alexia dashboard config target-app launcher.py MainFrame.py requirements.txt package.json .env.example; do
  [ -e "$SRC/$item" ] && cp -a "$SRC/$item" "$APP_DIR/"
done

say "Installing Python dependencies in $APP_DIR/.venv"
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip -q
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt" -q
chown -R root:root "$APP_DIR"

# ---------------------------------------------------------------- systemd service
say "Installing the systemd service"
cat > "$SERVICE" <<EOF
[Unit]
Description=Alexia Autonomous DevSecOps Guardian
Documentation=https://github.com/Destroyerved/Alexia
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=alexia
Group=alexia
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=ALEXIA_SUPERVISED=1
ExecStart=$APP_DIR/.venv/bin/python $APP_DIR/launcher.py --no-browser
Restart=always
RestartSec=2
TimeoutStopSec=20
LimitNOFILE=65536

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR $BACKUP_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable alexia >/dev/null
systemctl restart alexia

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  say "Opening firewall: 8080/tcp (Alexia Guardian API & Console)"
  ufw allow 8080/tcp >/dev/null
fi

sleep 3
if systemctl is-active --quiet alexia; then
  say "Alexia $VERSION is running"
else
  journalctl -u alexia -n 40 --no-pager
  die "The service did not start — the log is above."
fi

echo
for ip in $(hostname -I); do
  case "$ip" in *:*) continue ;; esac
  echo "   Guardian Console  http://$ip:8080"
done
echo "   Data              $DATA_DIR"
echo "   Backups           $BACKUP_DIR"
echo "   Settings          $ENV_FILE"
echo "   Logs              journalctl -u alexia -f"
if [ "$FIRST_INSTALL" = 1 ]; then
  echo
  echo "   First admin       admin@alexia.local"
  echo "   Password          $ADMIN_PASSWORD"
  echo "   Demo operator     demo / alexiaguardian2026"
fi
echo
