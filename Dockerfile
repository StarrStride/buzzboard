# syntax=docker/dockerfile:1

# ==================================================
# BUILD THE REACT / VITE CLIENT
# ==================================================

FROM node:22-alpine AS client-build

WORKDIR /app/client

COPY client/package*.json ./

RUN npm install

COPY client/ ./

ARG VITE_DISCORD_CLIENT_ID

ENV VITE_DISCORD_CLIENT_ID=${VITE_DISCORD_CLIENT_ID}

RUN if [ -z "$VITE_DISCORD_CLIENT_ID" ]; then \
      echo "ERROR: VITE_DISCORD_CLIENT_ID is required at build time."; \
      exit 1; \
    fi

RUN npm run build


# ==================================================
# PRODUCTION RUNTIME
# ==================================================

FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY server/package*.json ./server/

RUN cd server && npm install --omit=dev

COPY server/ ./server/

COPY --from=client-build /app/client/dist ./client/dist

WORKDIR /app/server

EXPOSE 8080

CMD ["npm", "start"]