FROM node:20-alpine

WORKDIR /app

# Build client
COPY client/package*.json ./client/
RUN cd client && npm ci

COPY client/ ./client/
RUN cd client && npm run build

# Install server deps
COPY server/package*.json ./server/
RUN cd server && npm ci

COPY server/ ./server/

EXPOSE 3001

WORKDIR /app/server
CMD ["npx", "ts-node", "--esm", "index.ts"]
