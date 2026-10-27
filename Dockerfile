# Single image: builds the React client, then serves it from the Node API/gateway.
FROM node:22-alpine AS build
WORKDIR /app
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY client client
RUN npm run build -w client

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production MONGOMS_DISABLE_POSTINSTALL=1 USE_MEMORY_DB=false
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY server server
COPY --from=build /app/client/dist client/dist
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["node", "server/src/index.js"]
