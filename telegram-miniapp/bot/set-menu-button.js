/**
 * Set Telegram Bot Menu Button (bottom left corner button)
 * This creates a persistent button that opens the Mini App
 */

const https = require('https');

const BOT_TOKEN = '8881301382:AAFoB52OPi5VredsbOE7F0mh_SBZubqabj8';
const WEBAPP_URL = 'https://three-moons-behave.loca.lt';

// Set Menu Button for all users
function setMenuButton() {
  const data = JSON.stringify({
    menu_button: {
      type: 'web_app',
      text: '🚀 Открыть',
      web_app: {
        url: WEBAPP_URL
      }
    }
  });

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${BOT_TOKEN}/setChatMenuButton`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => responseData += chunk);
      res.on('end', () => {
        const result = JSON.parse(responseData);
        if (result.ok) {
          console.log('✅ Menu Button set successfully!');
          console.log('   Button text: 🚀 Открыть');
          console.log('   WebApp URL:', WEBAPP_URL);
          resolve(result);
        } else {
          console.log('❌ Failed to set Menu Button:', result.description);
          reject(result);
        }
      });
    });

    req.on('error', (error) => {
      console.error('❌ Error:', error.message);
      reject(error);
    });

    req.write(data);
    req.end();
  });
}

// Also set bot commands for /start, /help, etc.
function setCommands() {
  const data = JSON.stringify({
    commands: [
      { command: 'start', description: 'Запустить бота' },
      { command: 'help', description: 'Помощь' },
      { command: 'status', description: 'Проверить подписку' }
    ]
  });

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${BOT_TOKEN}/setMyCommands`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => responseData += chunk);
      res.on('end', () => {
        const result = JSON.parse(responseData);
        if (result.ok) {
          console.log('✅ Bot commands set!');
          console.log('   /start - Запустить бота');
          console.log('   /help - Помощь');
          console.log('   /status - Проверить подписку');
          resolve(result);
        } else {
          console.log('❌ Failed to set commands:', result.description);
          reject(result);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Run both
async function setupBot() {
  console.log('Setting up Telegram bot...\n');
  
  try {
    await setMenuButton();
    console.log('');
    await setCommands();
    console.log('\n🎉 Bot setup complete!');
    console.log('   Users will now see 🚀 Открыть button in the menu (bottom left)');
  } catch (error) {
    console.error('Setup failed:', error);
  }
}

setupBot();
