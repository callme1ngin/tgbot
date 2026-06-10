#!/bin/bash

# Production deployment script для Telegram HTML Bot на Linux

set -e

echo "🚀 Deploying Telegram HTML Bot..."

# 1. Установка зависимостей
echo "📦 Installing dependencies..."
npm ci

echo "🧩 Building templates..."
npm run bundle:friendpage

# 2. Установка Playwright браузеров для Linux
echo "🔧 Installing Playwright browsers..."
npx playwright install --with-deps chromium

# 3. Оптимизация системы для Node.js
echo "⚙️  Optimizing system settings..."

# Увеличиваем лимит открытых файлов
if [ "$(ulimit -n)" -lt "65536" ]; then
  echo "Increasing file descriptor limit..."
  ulimit -n 65536
fi

# 4. Создание .env файла если его нет
if [ ! -f .env ]; then
  echo "📝 Creating .env file..."
  cp .env.example .env
  echo "⚠️  Please update .env with your BOT_TOKEN"
  exit 1
fi

# 5. Проверка NODE_ENV
export NODE_ENV=production

# 6. Запуск бота с PM2 (опционально)
if command -v pm2 &> /dev/null; then
  echo "🎯 Starting bot with PM2..."
  pm2 start src/bot.js --name "tg-html-bot" \
    --max-memory-restart 500M \
    --max-restarts 10 \
    --min-uptime 10s \
    --watch false \
    --error "./logs/error.log" \
    --out "./logs/out.log"

  echo "✓ Bot started with PM2"
  pm2 save
  pm2 startup
else
  echo "🎯 Starting bot with Node.js..."
  npm start
fi

echo "✓ Deployment complete"
