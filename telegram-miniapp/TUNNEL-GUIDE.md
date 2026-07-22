# HTTPS Tunnel для Telegram Mini App

Telegram Mini App требует **HTTPS URL** для работы. Используйте один из способов ниже:

## Способ 1: LocalTunnel (простой)

### 1. Убедитесь что frontend запущен:
```bash
cd telegram-miniapp/frontend
npm run dev
```

### 2. В новом терминале запустите туннель:
```bash
cd telegram-miniapp/frontend
npx localtunnel --port 5173
```

### 3. Получите URL:
```
your url is: https://random-string.loca.lt
```

### 4. Настройте бота в BotFather:
1. Отправьте `/mybots` @BotFather
2. Выберите @Soft777bot
3. Нажмите **Bot Settings**
4. Нажмите **Menu Button**
5. Нажмите **Configure menu button**
6. Введите:
   - **Name**: 🚀 Open App
   - **URL**: `https://random-string.loca.lt`

### 5. Перезапустите бота:
```bash
cd telegram-miniapp/bot
node bot.js
```

## Способ 2: Ngrok (нужна регистрация)

### 1. Установите ngrok:
```bash
npm install -g ngrok
```

### 2. Зарегистрируйтесь на https://ngrok.com и получите auth token

### 3. Настройте auth token:
```bash
ngrok config add-authtoken YOUR_TOKEN
```

### 4. Запустите туннель:
```bash
ngrok http 5173
```

### 5. Используйте HTTPS URL из вывода

## Способ 3: Cloudflare Tunnel (cloudflared)

### 1. Скачайте cloudflared:
https://github.com/cloudflare/cloudflared/releases

### 2. Запустите:
```bash
cloudflared tunnel --url http://localhost:5173
```

### 3. Используйте URL вида `https://xxxx.trycloudflare.com`

## Quick Start Script

Для Windows PowerShell:
```powershell
cd telegram-miniapp
.\start-tunnel.ps1
```

Для Windows CMD:
```cmd
cd telegram-miniapp
start-tunnel.bat
```

## Проверка работы

После настройки:
1. Отправьте `/start` боту @Soft777bot
2. Должна появиться кнопка **🚀 Open App** или **Menu Button**
3. Нажмите — откроется Mini App через HTTPS!

## Важно!

- **Frontend должен быть запущен** на порту 5173
- **Туннель должен быть активен** (не закрывайте терминал)
- **При перезапуске туннеля URL меняется** — обновите в BotFather
- **Для production** используйте Vercel/Cloudflare Pages (постоянный HTTPS URL)
