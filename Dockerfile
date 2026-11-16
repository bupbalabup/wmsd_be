# syntax=docker/dockerfile:1
# One Dockerfile, two targets:
#   dev  - hot reload (nodemon); source is bind-mounted by ../docker-compose.yml
#   prod - default (last stage): production dependencies only, non-root user
#   docker build -t wmsd-api building-material-management

FROM node:20-alpine AS base
WORKDIR /app
ENV PORT=3000
EXPOSE 3000

# --- dev: full dependencies, rewrites a host-style Mongo URI to the Docker host ---
FROM base AS dev
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
RUN <<'EOF_SCRIPT'
cat > /usr/local/bin/dev-entrypoint.sh <<'EOS'
#!/bin/sh
set -e
# A host .env usually points at localhost; inside the container that is not the host.
if [ -n "$MONGODB_URI" ]; then
  MONGODB_URI=$(printf '%s' "$MONGODB_URI" | sed -E \
    -e 's#@(localhost|127\.0\.0\.1)#@host.docker.internal#' \
    -e 's#//(localhost|127\.0\.0\.1)#//host.docker.internal#')
  export MONGODB_URI
fi
exec "$@"
EOS
chmod +x /usr/local/bin/dev-entrypoint.sh
EOF_SCRIPT
ENTRYPOINT ["dev-entrypoint.sh"]
CMD ["npm", "run", "dev"]

# --- production dependencies ---
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# --- prod: final image ---
FROM base AS prod
ENV NODE_ENV=production
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
