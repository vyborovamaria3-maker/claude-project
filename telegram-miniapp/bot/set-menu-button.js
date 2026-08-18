/**
 * Set Telegram Bot Menu Button (bottom left corner button).
 * Requires BOT_TOKEN and WEBAPP_URL via environment variables.
 */

const https = require('https');
require('dotenv').config();

function requireEnv(name) {
  const value = process.env[name] && process.env[name].trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const BOT_TOKEN = requireEnv('BOT_TOKEN');
const WEBAPP_URL = requireEnv('WEBAPP_URL');

function telegramRequest(method, data) {
  const body = JSON.stringify(data);
  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${BOT_TOKEN}/${method}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(responseData);
          if (result.ok) return resolve(result);
          reject(new Error(result.description || `Telegram ${method} failed`));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function setMenuButton() {
  await telegramRequest('setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: '🚀 Открыть',
      web_app: { url: WEBAPP_URL }
    }
  });
  console.log('✅ Menu Button set successfully!');
}

async function setCommands() {
  await telegramRequest('setMyCommands', {
    commands: [
      { command: 'start', description: 'Запустить бота' },
      { command: 'help', description: 'Помощь' },
      { command: 'status', description: 'Проверить подписку' }
    ]
  });
  console.log('✅ Bot commands set!');
}

async function setupBot() {
  console.log('Setting up Telegram bot...');
  try {
    await setMenuButton();
    await setCommands();
    console.log('🎉 Bot setup complete!');
  } catch (error) {
    console.error('Setup failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void setupBot();
