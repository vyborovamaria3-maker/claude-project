#!/bin/bash

# AI Reply Guy - Quick Setup Script
# Быстрое развёртывание всего проекта

echo "🚀 AI Reply Guy - Установка и запуск"

# Check dependencies
command -v docker >/dev/null 2>&1 || { echo "Docker is required. Please install Docker."; exit 1; }
command -v docker-compose >/dev/null 2>&1 || { echo "docker-compose is required. Please install docker-compose."; exit 1; }

# Create .env file with secure keys
echo "🔐 Генерация .env файла..."
cat > .env <<EOL
# Secure random keys
ENCRYPTION_KEY=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)

# Telegram and LLM (update these)
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
LLM_API_KEY=sk-your-openai-key
LLM_PROVIDER=openai

# Database credentials
POSTGRES_PASSWORD=secure_password_123
EOL

# Build all containers
echo "🏗️ Сборка контейнеров..."
docker-compose build --no-cache

# Start all services
echo "🚀 Запуск всех сервисов..."
docker-compose up -d

# Wait for services
echo "⏳ Ожидание запуска сервисов..."
sleep 10

# Check health
echo "🩺 Проверка здоровья сервисов..."
docker-compose ps

# Run migrations
echo "🗄️ Применение миграций базы данных..."
docker-compose run --rm backend python -c "
from app.db.base import init_db
init_db()
"

echo "✅ Развертывание завершено!"
echo ""
echo "📊 Панель управления:"
echo "   Backend API: http://localhost:8000"
echo "   Frontend: http://localhost:3000"
echo "   Telegram Bot: http://localhost:8080"
echo "   RabbitMQ Management: http://localhost:15672 (user: ai_reply_guy / pass: secure_password_123)"
echo ""
echo "🔑 Используйте следующие логин/пароль:"
echo "   API: JWT токен (используется в Telegram боте)"
echo "   RabbitMQ: ai_reply_guy / secure_password_123"
echo ""
echo "📝 Для остановки: docker-compose down"
echo "🔄 Для перезапуска с развертыванием: docker-compose up -d --build"
