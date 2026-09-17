FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
ARG DATABASE_PROVIDER=sqlite
ENV DATABASE_PROVIDER=${DATABASE_PROVIDER}
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
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
COPY scripts/start-container.mjs ./scripts/start-container.mjs
COPY tests ./tests
RUN npm test && npm run build
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "scripts/start-container.mjs"]
