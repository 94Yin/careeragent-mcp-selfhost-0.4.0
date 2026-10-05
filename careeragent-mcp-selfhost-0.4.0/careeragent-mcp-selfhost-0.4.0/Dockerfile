FROM node:22.21.0-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV MOCK_MODE=true

EXPOSE 3000

CMD ["npm", "start"]
