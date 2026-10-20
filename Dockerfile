FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV HOST=0.0.0.0
ENV PORT=4317
ENV DATABASE_PATH=/data/pr-dash.sqlite
VOLUME ["/data"]
EXPOSE 4317
CMD ["npx", "tsx", "src/server/index.ts"]
