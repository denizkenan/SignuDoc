# The SignuDoc app as a container, for Cloudflare Containers. Built with the
# repository root as its context (see wrangler.jsonc).
FROM node:24-slim AS build

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
ENV SIGNUDOC_STANDALONE=1
RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/src/assets/fonts ./src/assets/fonts
COPY --from=build --chown=node:node /app/node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm ./node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm

USER node
EXPOSE 8080

# Apply any new database migrations, then serve. The migration takes a lock
# in the database, so two containers starting together do not collide.
# "--optional" lets the app start before a database is connected: it then
# shows a page that says so, as it does on Vercel.
CMD ["sh", "-c", "node db/migrate.mjs --optional && exec node server.js"]
