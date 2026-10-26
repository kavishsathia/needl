# Needl on Google Cloud Run: the same app as needl.dev, built from source.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package-lock.json apps/web/
RUN npm ci && npm --prefix apps/web ci --legacy-peer-deps

COPY . .
RUN npm --prefix apps/web run build

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app/apps/web
EXPOSE 8080
CMD ["npx", "tsx", "server.ts"]
