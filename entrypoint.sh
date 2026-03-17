#!/bin/sh
set -e

# Run database migrations
npx prisma migrate deploy

# Remove stale Chromium lock files from previous containers
find /app/.wwebjs_auth -name 'SingletonLock' -o -name 'SingletonSocket' -o -name 'SingletonCookie' 2>/dev/null | xargs rm -f || true

# Execute the main command
exec "$@"
