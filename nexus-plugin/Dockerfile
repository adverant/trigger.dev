# =============================================================================
# Nexus Trigger.dev Plugin - Multi-stage Production Build
# =============================================================================
# Stage 1: UI Builder (Next.js static export)
# Stage 2: Backend Builder (TypeScript compilation)
# Stage 3: Production Runtime
# =============================================================================

# Build arguments
ARG BUILD_ID=dev
ARG BUILD_TIMESTAMP=unknown
ARG GIT_COMMIT=unknown
ARG GIT_BRANCH=unknown
ARG VERSION=1.0.0

# =============================================================================
# Stage 1: UI Builder
# =============================================================================
FROM node:20-alpine AS ui-builder

WORKDIR /ui

# Copy package manifests first for layer caching
COPY ui/package.json ui/package-lock.json ./

# Install dependencies
RUN npm ci --ignore-scripts

# Copy UI source
COPY ui/ ./

# Build Next.js static export (produces out/ directory)
RUN npm run build

# =============================================================================
# Stage 2: Backend Builder
# =============================================================================
FROM node:20-alpine AS backend-builder

# Install build dependencies for native modules (pg, bcrypt, etc.)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package manifests first for layer caching
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code and TypeScript config
COPY src/ ./src/
COPY tsconfig.json ./

# Compile TypeScript
RUN npx tsc -p tsconfig.json

# Prune devDependencies for production
RUN npm prune --production

# =============================================================================
# Stage 3: Production Runtime
# =============================================================================
FROM node:20-alpine AS production

# Install dumb-init for proper PID 1 signal handling
RUN apk add --no-cache dumb-init wget

# Build metadata labels
ARG BUILD_ID
ARG BUILD_TIMESTAMP
ARG GIT_COMMIT
ARG GIT_BRANCH
ARG VERSION

LABEL org.opencontainers.image.title="Nexus Trigger.dev Plugin" \
      org.opencontainers.image.description="Durable task execution, AI agent orchestration, and background job scheduling for Adverant Nexus" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_TIMESTAMP}" \
      org.opencontainers.image.source="https://github.com/adverant/trigger.dev" \
      org.opencontainers.image.vendor="Adverant AI" \
      org.opencontainers.image.licenses="Apache-2.0" \
      ai.adverant.plugin.id="nexus-trigger" \
      ai.adverant.plugin.version="${VERSION}" \
      ai.adverant.build.id="${BUILD_ID}" \
      ai.adverant.build.branch="${GIT_BRANCH}"

WORKDIR /app

# Create logs directory (winston-daily-rotate-file needs it writable)
RUN mkdir -p /app/logs && chown 1001:1001 /app/logs

# Copy compiled backend
COPY --from=backend-builder --chown=1001:1001 /app/dist ./dist
COPY --from=backend-builder --chown=1001:1001 /app/node_modules ./node_modules
COPY --from=backend-builder --chown=1001:1001 /app/package.json ./package.json

# Copy static UI build
COPY --from=ui-builder --chown=1001:1001 /ui/out ./ui/out

# Set environment variables
ENV NODE_ENV=production \
    PORT=8080

# Run as non-root user
USER 1001

# Expose application port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q --spider http://localhost:8080/trigger/health || exit 1

# Use dumb-init as PID 1
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Start the application
CMD ["node", "dist/index.js"]
