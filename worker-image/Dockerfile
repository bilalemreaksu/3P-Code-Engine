# Worker image for CODE_MODE_ISOLATION=docker. The untrusted worker runs
# here; only the job's project directory is mounted (at /work) and the
# host's loopback interface (approval broker) is unreachable from the
# container. Build from the repository root:
#   docker build -t 3p-code-engine-worker -f worker-image/Dockerfile .
FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Local modules the worker imports (worker, policy, hooks, mcp bridge).
COPY code-mode-worker.mjs code-mode-policy.mjs code-mode-channel.mjs code-mode-hooks.mjs code-mode-mcp.mjs code-mode-rpc.mjs code-mode-runtime.mjs code-mode-rules.mjs ./

ENV NODE_ENV=production
