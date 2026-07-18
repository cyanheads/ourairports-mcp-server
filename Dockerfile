# ==============================================================================
# Build Stage
#
# This stage installs all dependencies (including dev), builds the TypeScript
# source code into JavaScript, and prepares the production assets.
# ==============================================================================
FROM oven/bun:1.3.14 AS build

WORKDIR /usr/src/app

# Copy dependency manifests for optimized layer caching
COPY package.json bun.lock ./

# Install all dependencies (including dev dependencies for building).
# The BuildKit cache mount persists Bun's global package cache across builds.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts

# Copy the rest of the source code
COPY . .

# Fetch and bundle the OurAirports CSVs into data/ so the image is self-contained
# (the server loads this bundled payload at setup() and never touches the network
# at runtime). A weekly image rebuild refreshes the snapshot from the daily mirror.
RUN bun run build:data

# Build the application
RUN bun run build


# ==============================================================================
# Production Stage
#
# This stage creates a minimal, optimized, and secure image for running the
# application. It uses a slim base image and only includes production
# dependencies and build artifacts.
# ==============================================================================
FROM oven/bun:1.3.14-slim AS production

WORKDIR /usr/src/app

# Set the environment to production for performance and to ensure only
# production dependencies are installed.
ENV NODE_ENV=production

# OCI image metadata (https://github.com/opencontainers/image-spec/blob/main/annotations.md)
ARG APP_VERSION
LABEL org.opencontainers.image.title="ourairports-mcp-server"
LABEL org.opencontainers.image.description="Resolve airport codes (IATA/ICAO/GPS/local), search airports, find the nearest by coordinate, and look up runways, navaids, and radio frequencies from the bundled public-domain OurAirports dataset via MCP. STDIO or Streamable HTTP."
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/cyanheads/ourairports-mcp-server"

# Copy dependency manifests
COPY package.json bun.lock ./

# Install only production dependencies, ignoring any lifecycle scripts (like 'prepare')
# that are not needed in the final production image.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production --frozen-lockfile --ignore-scripts

# Conditionally install OpenTelemetry optional peer dependencies (Tier 3).
# These are not bundled by default to keep the base image lean. Enable at build time
# with: docker build --build-arg OTEL_ENABLED=true
ARG OTEL_ENABLED=true
RUN --mount=type=cache,target=/root/.bun/install/cache \
    if [ "$OTEL_ENABLED" = "true" ]; then \
      bun add @hono/otel \
        @opentelemetry/instrumentation-http \
        @opentelemetry/exporter-metrics-otlp-http \
        @opentelemetry/exporter-trace-otlp-http \
        @opentelemetry/instrumentation-pino \
        @opentelemetry/resources \
        @opentelemetry/sdk-metrics \
        @opentelemetry/sdk-node \
        @opentelemetry/sdk-trace-node \
        @opentelemetry/semantic-conventions; \
    fi

# Copy the compiled application code from the build stage
COPY --from=build /usr/src/app/dist ./dist

# Copy the bundled OurAirports CSVs. The runtime resolves the data directory by
# walking up to the nearest ancestor holding both package.json and data/, so the
# dataset must ship alongside dist/ in the production image — without this the
# server has no data to load at setup().
COPY --from=build /usr/src/app/data ./data

# Mirror CLI (MirrorService adopters only — Tier 3, opt-in):
# Copy your mirror lifecycle scripts and emit a runtime tsconfig so Bun resolves
# the @/ path alias against ./dist/ rather than ./src/.
# See the api-mirror skill for the full recipe.
#
# COPY --from=build /usr/src/app/scripts/<your>-mirror-init.ts \
#                   /usr/src/app/scripts/<your>-mirror-refresh.ts \
#                   /usr/src/app/scripts/<your>-mirror-verify.ts \
#                   /usr/src/app/scripts/_mirror-context.ts \
#                   ./scripts/
# RUN echo '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./dist/*"]}}}' > tsconfig.json

# The 'oven/bun' image already provides a non-root user named 'bun'.
# We will use this existing user for enhanced security.

# Create and set permissions for the log directory, assigning ownership to the 'bun' user.
RUN mkdir -p /var/log/ourairports-mcp-server && chown -R bun:bun /var/log/ourairports-mcp-server

# Writable data dirs for on-disk SQLite stores (catalog index / observations
# mirror), owned by the runtime user. Mount a volume over either in production.
RUN mkdir -p /usr/src/app/.cache /usr/src/app/.mirror \
  && chown -R bun:bun /usr/src/app/.cache /usr/src/app/.mirror

# Switch to the non-root user
USER bun

# Define an argument for the port, allowing it to be overridden at build time.
# The `PORT` variable is often injected by cloud environments at runtime.
ARG PORT

# Set runtime environment variables
# Note: PORT is an automatic variable in many cloud environments (e.g., Cloud Run)
ENV MCP_HTTP_PORT=${PORT:-3010}
ENV MCP_HTTP_HOST="0.0.0.0"
ENV MCP_TRANSPORT_TYPE="http"
ENV MCP_SESSION_MODE="stateless"
ENV MCP_LOG_LEVEL="info"
ENV LOGS_DIR="/var/log/ourairports-mcp-server"
ENV MCP_FORCE_CONSOLE_LOGGING="true"

# Expose the port the server listens on
EXPOSE ${MCP_HTTP_PORT}

# Health check using a bun-native fetch (slim image ships no curl/wget)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD bun -e "fetch('http://localhost:'+(process.env.MCP_HTTP_PORT??'3010')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The command to start the server
CMD ["bun", "run", "dist/index.js"]
