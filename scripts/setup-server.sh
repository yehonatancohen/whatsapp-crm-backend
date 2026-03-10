#!/usr/bin/env bash
set -euo pipefail

# ── WhatsApp CRM Backend — Oracle Server Bootstrap ─────────────────
# Usage: curl -fsSL https://raw.githubusercontent.com/yehonatancohen/whatsapp-crm-backend/main/scripts/setup-server.sh | bash

REPO_RAW="https://raw.githubusercontent.com/yehonatancohen/whatsapp-crm-backend/main"
INSTALL_DIR="$HOME/whatsapp-crm"

echo "╔══════════════════════════════════════════════════╗"
echo "║   WhatsApp CRM Backend — Server Setup           ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── 1. Install Docker if not present ───────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "→ Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  echo "  Docker installed. You may need to log out and back in for group changes."
fi

# ── 2. Install Docker Compose plugin if not present ────────────────
if ! docker compose version &>/dev/null; then
  echo "→ Installing Docker Compose plugin..."
  sudo mkdir -p /usr/local/lib/docker/cli-plugins
  COMPOSE_URL="https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)"
  sudo curl -fsSL "$COMPOSE_URL" -o /usr/local/lib/docker/cli-plugins/docker-compose
  sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi

echo "→ Docker version: $(docker --version)"
echo "→ Compose version: $(docker compose version)"
echo ""

# ── 3. Create install directory ────────────────────────────────────
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# ── 4. Download docker-compose.yml ─────────────────────────────────
echo "→ Downloading docker-compose.yml..."
curl -fsSL "$REPO_RAW/docker-compose.yml" -o docker-compose.yml

# ── 5. Create .env file if it doesn't exist ────────────────────────
if [ ! -f .env ]; then
  echo ""
  echo "→ Setting up environment variables..."
  echo "  (Leave blank to skip, you can edit $INSTALL_DIR/.env later)"
  echo ""

  read -rp "  POSTGRES_PASSWORD: " POSTGRES_PASSWORD
  read -rp "  JWT_SECRET: " JWT_SECRET
  read -rp "  JWT_REFRESH_SECRET: " JWT_REFRESH_SECRET
  read -rp "  CORS_ORIGIN [https://whatsapp-crm-frontend.vercel.app]: " CORS_ORIGIN
  CORS_ORIGIN="${CORS_ORIGIN:-https://whatsapp-crm-frontend.vercel.app}"
  read -rp "  CLOUDFLARE_TUNNEL_TOKEN: " CLOUDFLARE_TUNNEL_TOKEN

  cat > .env <<EOF
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
JWT_SECRET=${JWT_SECRET}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
CORS_ORIGIN=${CORS_ORIGIN}
CLOUDFLARE_TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}
EOF

  echo ""
  echo "  ✓ .env created at $INSTALL_DIR/.env"
else
  echo "→ .env already exists, skipping..."
fi

# ── 6. Pull images and start ───────────────────────────────────────
echo ""
echo "→ Pulling images..."
docker compose pull

echo "→ Starting services..."
docker compose up -d

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   Setup complete!                               ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║                                                  ║"
echo "║   Services are running at $INSTALL_DIR           ║"
echo "║                                                  ║"
echo "║   Useful commands:                               ║"
echo "║     cd $INSTALL_DIR                              ║"
echo "║     docker compose logs -f                       ║"
echo "║     docker compose ps                            ║"
echo "║                                                  ║"
echo "║   Watchtower will auto-update the app every 60s  ║"
echo "║   when new images are pushed to Docker Hub.      ║"
echo "║                                                  ║"
echo "╚══════════════════════════════════════════════════╝"
