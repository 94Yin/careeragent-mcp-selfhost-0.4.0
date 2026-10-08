FROM node:22.21.0-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js adapter.js ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV MOCK_MODE=false

EXPOSE 3000

CMD ["npm", "start"]
