# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma/ ./prisma/
RUN npx prisma generate

COPY src/ ./src/
RUN npm run build

# ── Stage 2: Production runtime ────────────────────────────────
FROM node:20-slim

# Install Chromium, ffmpeg (for WebM→OGG voice conversion), and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ffmpeg \
    fonts-ipafont-gothic \
    fonts-freefont-ttf \
    fonts-noto-color-emoji \
    libxss1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libgbm1 \
    libasound2 \
    ca-certificates \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system Chromium instead of downloading its own
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Create a non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser -G audio,video appuser \
    && mkdir -p /home/appuser && chown -R appuser:appuser /home/appuser

WORKDIR /app

# Install only production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy Prisma schema + generated client + migrations
COPY prisma/ ./prisma/
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Copy the patch-package-patched whatsapp-web.js file from the builder stage.
# patch-package is a devDependency so it only runs in the builder; we carry
# the already-patched file into the production image instead of re-patching here.
COPY --from=builder /app/node_modules/whatsapp-web.js/src/util/Injected/Utils.js \
     ./node_modules/whatsapp-web.js/src/util/Injected/Utils.js

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist

# Copy entrypoint script
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Ensure .wwebjs_auth dir exists and is owned by appuser
RUN mkdir -p /app/.wwebjs_auth && chown -R appuser:appuser /app
USER appuser

EXPOSE 3001

ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "dist/index.js"]
