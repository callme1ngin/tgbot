FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

ENV NODE_OPTIONS="--max-old-space-size=512"
ENV NODE_ENV=production

CMD ["npm", "start"]
