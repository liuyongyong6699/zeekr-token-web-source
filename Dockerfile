# Zeekr Token Local Web - Docker for ARM64
# Build: docker buildx build --platform linux/arm64 -t zeekr-token-web .
# Run:   docker run -d --name zeekr-token -p 8767:8767 zeekr-token-web

FROM node:22-alpine AS builder

# Install Chromium dependencies and Chromium itself
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-cjk \
    font-noto-emoji \
    && rm -rf /var/cache/apk/*

# Set Chromium path for Playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy source code
COPY . .

# Verify Chromium works
RUN /usr/bin/chromium --version

# ---- Runtime stage ----
FROM node:22-alpine AS runtime

# Install runtime dependencies
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-cjk \
    font-noto-emoji \
    && rm -rf /var/cache/apk/*

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/server.cjs ./
COPY --from=builder /app/official.cjs ./
COPY --from=builder /app/deadline.cjs ./
COPY --from=builder /app/public ./public

# Create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Chromium needs these for --no-sandbox in containers
USER root
RUN mkdir -p /home/appuser && chown -R appuser:appgroup /home/appuser
USER appuser

EXPOSE 8767

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8767/api/bootstrap || exit 1

CMD ["node", "server.cjs"]