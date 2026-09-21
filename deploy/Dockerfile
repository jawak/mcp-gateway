# mcp-gateway runtime image.
#
# Base note: the gateway spawns upstream MCP servers as child processes, so the
# image needs the runtimes those commands resolve to (npx / uvx / docker CLI).
# `node:22-bookworm-slim` + bun gives us Node and a package-cache-friendly apt;
# python/uv is installed for `uvx` servers, and the docker CLI can be mounted in
# rather than baked in (socket access is a host-level trust decision, not an
# image one).
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/*
RUN npm install -g bun@1
COPY package.json bun.lock ./
# only what the build needs; runtime deps are pruned in the final stage
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
	PORT=8080 \
	MCPGW_HOST=0.0.0.0 \
	MCPGW_DATA_DIR=/data \
	MCPGW_ROOT_DIR=/app \
	BUN_ENV=production
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl python3 python3-pip \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install -g bun@1 \
	&& pip3 install --no-cache-dir --break-system-packages uv \
	&& mkdir -p /data \
	&& useradd --system --create-home --home-dir /var/lib/mcpgw --shell /usr/sbin/nologin mcpgw \
	&& chown -R mcpgw:mcpgw /data /var/lib/mcpgw

# Full dependency install, deliberately not `--production`: a server-rendered
# SvelteKit app loads @sveltejs/kit, svelte, devalue, cookie and friends at request
# time, and several of those are legitimately devDependencies for the build. Getting
# this split wrong produces an image that starts and then 500s on the first page view.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile && bun pm cache rm
# build output: Bun bundle + SvelteKit SSR bundle + client assets
COPY --from=build --chown=mcpgw:mcpgw /app/build ./build
COPY --from=build --chown=mcpgw:mcpgw /app/.svelte-kit/output ./.svelte-kit/output

USER mcpgw
EXPOSE 8080
VOLUME ["/data"]

# /healthz reflects gateway liveness; a failing upstream must not fail the container
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

CMD ["bun", "run", "start"]
