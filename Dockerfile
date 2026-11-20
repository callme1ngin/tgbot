FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

# The friend-page bundle is a committed file, produced by `npm run bundle:friendpage` on the machine that
# edits template-sources. It is not rebuilt here on purpose: .dockerignore keeps scripts/ and
# template-sources/ out of the image, so there is nothing to build from — and a build step that cannot
# run is worse than a documented one that does.

ENV NODE_OPTIONS="--max-old-space-size=512"
ENV NODE_ENV=production

CMD ["npm", "start"]
