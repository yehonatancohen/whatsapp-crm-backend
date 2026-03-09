#!/bin/sh
set -e

# Run database migrations
npx prisma migrate deploy

# Execute the main command
exec "$@"
