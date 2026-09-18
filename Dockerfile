FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
ARG DATABASE_PROVIDER=sqlite
ENV DATABASE_PROVIDER=${DATABASE_PROVIDER}
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates adb \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN mkdir -p /app/data /app/profiles
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund \
    && case "$DATABASE_PROVIDER" in \
      sqlite) ./node_modules/.bin/prisma generate --schema prisma/schema.prisma --generator client ;; \
      postgresql) ./node_modules/.bin/prisma generate --schema prisma/postgresql/schema.prisma --generator client ;; \
      *) exit 1 ;; \
    esac
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts/
COPY tests ./tests
# tests/radio-contract.test.ts reads these fixtures from disk, so the build-time test step needs
# them present. Without this the file throws while loading and its cases never run.
COPY contracts ./contracts
RUN npm test && if [ "$DATABASE_PROVIDER" = "sqlite" ]; then npm run test:warmup; fi && npm run build
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "scripts/start-container.mjs"]
