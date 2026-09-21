FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY contracts ./contracts
COPY src ./src

RUN npm run build


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV FREEPASS_DATA_DRIVER=firestore
ENV FIREBASE_PROJECT_ID=freepasserp5
ENV HOST=0.0.0.0

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY contracts ./contracts

USER node

CMD ["node", "dist/api/consumer-server.js"]
