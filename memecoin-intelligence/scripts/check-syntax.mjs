import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const roots = ['src', 'scripts', 'tools'];
const diagnostics = [];
let checked = 0;

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      checked += 1;
      const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
        },
      });
      for (const diagnostic of result.diagnostics ?? []) {
        diagnostics.push(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
      }
    }
  }
}

for (const root of roots) if (fs.existsSync(root)) walk(root);
if (diagnostics.length) {
  console.error(diagnostics.join('\n'));
  process.exit(1);
}
console.log(`Syntax OK: ${checked} TypeScript files`);
