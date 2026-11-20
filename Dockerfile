FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

# The friend page is assembled from template-sources: keep the bundle in step with them at build time,
# so a changed source can never ship next to a stale bundle.
RUN npm run bundle:friendpage

ENV NODE_OPTIONS="--max-old-space-size=512"
ENV NODE_ENV=production

CMD ["npm", "start"]
