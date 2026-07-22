const fs = require('fs');
const path = require('path');
const dir = 'c:\\Users\\Рафаил\\claude-project\\solana-launcher\\lib\\i18n\\messages';
fs.readdirSync(dir).filter(f => f.endsWith('.json')).forEach(f => {
  try {
    JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    console.log('OK:', f);
  } catch (e) {
    console.log('FAIL:', f, e.message);
  }
});
