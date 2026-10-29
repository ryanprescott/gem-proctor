# Web: static build (SPEC §11.5), served by the API in production. The container copies the build into the
# shared `web-dist` volume and exits.
FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY apps apps
COPY packages packages
COPY tools tools
RUN bun install --frozen-lockfile --ignore-scripts && bun run --filter @gem/web build

FROM busybox:1.37
COPY --from=build /app/apps/web/dist /dist
CMD ["sh", "-c", "rm -rf /web-dist/* && cp -r /dist/. /web-dist/ && echo web build copied"]
