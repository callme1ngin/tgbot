FROM mcr.microsoft.com/playwright:v1.60.0-noble

# Шрифты, которые ждут шаблоны: Arial (в Linux его нет — fontconfig подменяет Liberation Sans,
# метрически совпадающей), плюс базовый набор для китайских ников и эмодзи.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-liberation \
        fonts-dejavu-core \
        fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

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
