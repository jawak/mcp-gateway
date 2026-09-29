# mcp-gateway runtime image.
#
# The gateway spawns upstream MCP servers as child processes, so this image has to
# carry the runtimes those commands resolve to — `npx` needs Node, `uvx` needs
# Python + uv, and a bare `python3`/`node`/`bun` command needs its interpreter.
#
# There is deliberately NO docker CLI here. Running an upstream as a container is
# better served by running it as its own service and registering it as an HTTP
# upstream (see docker-compose.yml's sidecar pattern): mounting /var/run/docker.sock
# would hand anyone with a dashboard login root-equivalent control of the host,
# which cancels every containment control in this file.
#
# Two environment details that are easy to get wrong and silent when you do:
#   - HOME is set explicitly. npm and uv put their caches under it, and the spawn
#     helper drops an unset or empty HOME without complaint, so an operator who
#     overrides `user: "10001:10001"` (a uid with no /etc/passwd entry) would get a
#     gateway that starts and then fails every `npx`/`uvx` upstream with an ENOENT
#     that points nowhere near the cause.
#   - the account's shell is /bin/sh, not nologin. SHELL is passed to children (it is
#     on the spawn allowlist), and a child that shells out would exec nologin and die.
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
	HOME=/var/lib/mcpgw \
	BUN_ENV=production
# git: `uvx pkg @ git+…` and `npx <scope>/<pkg>#git-url` shell out to it, and the slim
#   base does not ship it.
# python3-venv: uv creates ephemeral environments for `uvx`; without the venv module a
#   fallback to the system interpreter fails at spawn time, not at install time.
#   Packages that must compile from source need build-essential too — add them in a
#   downstream image rather than paying for it on every deploy.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		curl \
		git \
		python3 \
		python3-pip \
		python3-venv \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install -g bun@1 \
	&& pip3 install --no-cache-dir --break-system-packages uv \
	&& mkdir -p /data \
	&& useradd --system --create-home --home-dir /var/lib/mcpgw --shell /bin/sh mcpgw \
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
# SQL migrations: the web process migrates once at boot and the worker refuses to
#   start until the schema exists — neither boots without this folder in the image.
COPY --from=build --chown=mcpgw:mcpgw /app/drizzle ./drizzle

USER mcpgw
EXPOSE 8080
VOLUME ["/data"]

# /healthz reflects gateway liveness; a failing upstream must not fail the container
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

CMD ["bun", "run", "start"]
