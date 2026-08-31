#!/bin/bash
# Deploy Muster+ to production

set -e

echo "=== Deploying Muster+ ==="

# Pull latest
git pull origin main

# Build
pnpm install
pnpm build

# Stop old container
docker compose down || true

# Start new container
docker compose -f docker-compose.prod.yml up -d

echo "=== Deployed! ==="
echo "Check status: docker compose ps"
