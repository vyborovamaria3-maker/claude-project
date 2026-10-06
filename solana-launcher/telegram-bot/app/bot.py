#!/usr/bin/env python3
"""
AI Reply Guy - Telegram Bot
Управление через Telegram бот
"""

from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    filters,
    ContextTypes,
)
import os
import requests
from datetime import datetime
from sqlalchemy.orm import Session
from app.db.session import get_db
from app.models.account import XAccount
from app.models.campaign import Campaign
from app.servicesTML import get_replies

# Telegram Bot Token
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "your-telegram-bot-token")

# API URL
API_URL = os.getenv("API_URL", "http://backend:8000")

class TelegramBot:
    def __init__(self):
        self.application = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
        self.setup_handlers()
    
    def setup_handlers(self):
        # Start command
        self.application.add_handler(CommandHandler("start", self.start))
        self.application.add_handler(CommandHandler("help", self.help))
        
        # Campaign management
        self.application.add_handler(CommandHandler("list_campaigns", self.list_campaigns))
        self.application.add_handler(CommandHandler("start_campaign", self.start_campaign))
        self.application.add_handler(CommandHandler("stop_campaign", self.stop_campaign))
        
        # Account management
        self.application.add_handler(CommandHandler("list_accounts", self.list_accounts))
        self.application.add_handler(CommandHandler("add_account", self.add_account))
        
        # Stats
        self.application.add_handler(CommandHandler("stats", self.stats))
        self.application.add_handler(CommandHandler("alerts", self.alerts))
        
        # Admin commands
        self.application.add_handler(CommandHandler("health", self.health_check))
    
    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Start command"""
        user = update.effective_user
        await update.message.reply_text(
            f"Привет, {user.first_name}!\n\n"
            "AI Reply Guy - автоматический Twitter ответчик.\n\n"
            "📋 Команды:\n"
            "/start - Эта помощь\n"
            "/list_campaigns - Список кампаний\n"
            "/add_account - Добавить X аккаунт\n"
            "/stats - Статистика\n"
            "/alerts - Уведомления\n"
            "/health - Проверка состояния\n"
        )
    
    async def health_check(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Check API health"""
        try:
            response = requests.get(f"{API_URL}/api/health", timeout=5)
            if response.status_code == 200:
                await update.message.reply_text("✅ Backend is running!")
            else:
                await update.message.reply_text(f"❌ Backend status: {response.status_code}")
        except Exception as e:
            await update.message.reply_text(f"❌ Backend is down: {str(e)}")
    
    async def list_campaigns(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """List campaigns"""
        user = update.effective_user
        try:
            response = requests.get(
                f"{API_URL}/api/campaigns",
                headers={"Authorization": f"Bearer {user.api_token}"},
                timeout=10
            )
            
            if response.status_code == 200:
                campaigns = response.json()
                if campaigns:
                    text = "Список кампаний:\n\n"
                    for i, campaign in enumerate(campaigns, 1):
                        status = campaign["status"].upper()
                        text += f"{i}. {campaign['name']} - {status}\n"
                    await update.message.reply_text(text)
                else:
                    await update.message.reply_text("Нет активных кампаний.")
            else:
                await update.message.reply_text("Ошибка при получении списка кампаний.")
        except Exception as e:
            await update.message.reply_text(f"Ошибка: {str(e)}")
    
    async def add_account(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Add new X account"""
        if not context.args:
            await update.message.reply_text("Используйте: /add_account @username")
            return
        
        username = context.args[0]
        user = update.effective_user
        
        try:
            response = requests.post(
                f"{API_URL}/api/accounts",
                json={"x_username": username},
                headers={"Authorization": f"Bearer {user.api_token}"},
                timeout=30
            )
            
            if response.status_code == 200:
                await update.message.reply_text(f"✅ Аккаунт @{username} успешно добавлен!")
            else:
                await update.message.reply_text("Ошибка при добавлении аккаунта.")
        except Exception as e:
            await update.message.reply_text(f"Ошибка: {str(e)}")
    
    async def stats(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Show statistics"""
        user = update.effective_user
        try:
            response = requests.get(
                f"{API_URL}/api/stats",
                headers={"Authorization": f"Bearer {user.api_token}"},
                timeout=10
            )
            
            if response.status_code == 200:
                stats = response.json()
                text = "📊 Статистика:\n\n"
                text += f"Аккаунтов: {stats['total_accounts']}\n"
                text += f"Кампаний: {stats['total_campaigns']}\n"
                text += f"Ответов сегодня: {stats['replies_today']}\n"
                text += f"Активных воркеров: {stats['running_workers']}\n"
                
                await update.message.reply_text(text)
            else:
                await update.message.reply_text("Ошибка при получении статистики.")
        except Exception as e:
            await update.message.reply_text(f"Ошибка: {str(e)}")
    
    async def alerts(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Show alerts"""
        user = update.effective_user
        try:
            response = requests.get(
                f"{API_URL}/api/alerts",
                headers={"Authorization": f"Bearer {user.api_token}"},
                timeout=10
            )
            
            if response.status_code == 200:
                alerts = response.json()
                if alerts:
                    text = "⚠️ Последние уведомления:\n\n"
                    for i, alert in enumerate(alerts[:10], 1):
                        type_ = alert["type"].upper()
                        msg = alert["message"]
                        text += f"{i}. [{type_}] {msg}\n"
                    
                    await update.message.reply_text(text)
                else:
                    await update.message.reply_text("Нет новых уведомлений.")
            else:
                await update.message.reply_text("Ошибка при получении уведомлений.")
        except Exception as e:
            await update.message.reply_text(f"Ошибка: {str(e)}")
    
    async def help(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Show help"""
        await update.message.reply_text(
            "🤖 AI Reply Guy - Помощь\n\n"
            "Основные команды:\n"
            "/start - Старт\n"
            "/add_account @username - Добавить аккаунт\n"
            "/list_campaigns - Список кампаний\n"
            "/start_campaign <id> - Запустить кампанию\n"
            "/stop_campaign <id> - Остановить кампанию\n"
            "/stats - Статистика\n"
            "/alerts - Уведомления\n"
            "/health - Проверка состояния\n"
            "/help - Эта справка\n\n"
            "💡 Делайте репосты регулярно, чтобы улучшать пользователей"
        )
    
    def run(self):
        """Start the bot"""
        print("🤖 Telegram Bot запускается...")
        self.application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    bot = TelegramBot()
    bot.run()
