import fs from 'node:fs';
import path from 'node:path';

const distRoot = path.resolve(process.argv[2] ?? 'dist');
const sourceRoot = path.join(distRoot, 'src');

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(file));
    else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) files.push(file);
  }
  return files;
}

function relativeSpecifier(fromFile, aliasPath) {
  const target = path.join(sourceRoot, aliasPath.slice(2));
  let relative = path.relative(path.dirname(fromFile), target).split(path.sep).join('/');
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative;
}

let rewrittenFiles = 0;
let rewrittenSpecifiers = 0;
for (const file of walk(distRoot)) {
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(/(['"])@\/(.+?)\1/g, (match, quote, aliasPath) => {
    rewrittenSpecifiers += 1;
    return `${quote}${relativeSpecifier(file, `@/${aliasPath}`)}${quote}`;
  });
  if (after !== before) {
    fs.writeFileSync(file, after);
    rewrittenFiles += 1;
  }
}

console.log(`Rewrote ${rewrittenSpecifiers} @/ import specifiers in ${rewrittenFiles} emitted files`);
