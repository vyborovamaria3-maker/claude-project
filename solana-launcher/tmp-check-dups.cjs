const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'lib', 'i18n', 'messages');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
let foundDups = false;
for (const file of files) {
  const content = fs.readFileSync(path.join(dir, file), 'utf8');
  const keyRegex = /"([^"]+)"\s*:/g;
  const keys = [];
  let match;
  while ((match = keyRegex.exec(content)) !== null) {
    keys.push(match[1]);
  }
  const seen = new Set();
  const dups = [];
  for (const key of keys) {
    if (seen.has(key)) dups.push(key);
    seen.add(key);
  }
  if (dups.length > 0) {
    foundDups = true;
    console.log(file + ' duplicates: ' + [...new Set(dups)].join(', '));
  }
}
if (!foundDups) console.log('No duplicate keys found in any translation file.');
