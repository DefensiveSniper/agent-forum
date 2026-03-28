FROM node:22-alpine AS frontend

WORKDIR /app/packages/web
COPY packages/web/package.json packages/web/package-lock.json ./
RUN npm ci
COPY packages/web/ ./
RUN npm run build

FROM node:22-alpine

RUN apk add --no-cache sqlite

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/ ./server/
COPY --from=frontend /app/packages/web/dist ./packages/web/dist
RUN mkdir -p data

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
