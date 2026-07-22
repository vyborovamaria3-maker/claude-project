const fs = require('fs');
const path = require('path');

// Read all translation keys from en.json
const enJsonPath = 'c:\\Users\\Рафаил\\claude-project\\solana-launcher\\lib\\i18n\\messages\\en.json';
const enKeys = Object.keys(JSON.parse(fs.readFileSync(enJsonPath, 'utf8')));
const enSet = new Set(enKeys);

// Extract t(...) keys from source files
function extractKeys(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const keys = new Set();
  // Match t("key" or t('key'
  const regex = /t\(\s*["']([^"']+)["']/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    keys.add(match[1]);
  }
  return keys;
}

function walk(dir, extensions, cb) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walk(full, extensions, cb);
    } else if (extensions.some(ext => full.endsWith(ext))) {
      cb(full);
    }
  }
}

const appDir = 'c:\\Users\\Рафаил\\claude-project\\solana-launcher\\app';
const componentsDir = 'c:\\Users\\Рафаил\\claude-project\\solana-launcher\\components';
const allSourceKeys = new Set();

walk(appDir, ['.tsx', '.ts'], (file) => {
  for (const k of extractKeys(file)) allSourceKeys.add(k);
});
walk(componentsDir, ['.tsx', '.ts'], (file) => {
  for (const k of extractKeys(file)) allSourceKeys.add(k);
});

const missing = [];
for (const k of allSourceKeys) {
  if (!enSet.has(k)) missing.push(k);
}

if (missing.length === 0) {
  console.log('All translation keys found in en.json');
} else {
  console.log('Missing keys in en.json:');
  missing.sort().forEach(k => console.log('  -', k));
}

// Also check for keys in en.json that are never used
const used = new Set();
for (const k of allSourceKeys) used.add(k);
const unused = enKeys.filter(k => !used.has(k));
if (unused.length > 0) {
  console.log('\nPotentially unused keys in en.json:');
  unused.forEach(k => console.log('  -', k));
}
