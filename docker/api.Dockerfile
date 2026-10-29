# API (Fastify on Bun + pg-boss workers), SPEC §11.5.
FROM oven/bun:1.4.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/authz/package.json packages/authz/
COPY packages/db/package.json packages/db/
COPY packages/llm/package.json packages/llm/
COPY packages/knowledge/package.json packages/knowledge/
COPY packages/authoring/package.json packages/authoring/
COPY tools/biome/package.json tools/biome/
COPY tools/i18n/package.json tools/i18n/
RUN bun install --frozen-lockfile --ignore-scripts

FROM oven/bun:1.4.4
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps ./apps
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/tools ./tools
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api apps/api
COPY packages packages
COPY docker/postgres/init.sql docker/postgres/init.sql
USER bun
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.API_PORT ?? 3000) + '/api/v1/health'); process.exit(r.status < 500 || r.status === 503 ? 0 : 1)"
CMD ["bun", "apps/api/src/main.ts"]
