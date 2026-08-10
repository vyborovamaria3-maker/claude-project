const Module = require('node:module');
const path = require('node:path');

const safeXlsx = require('./xlsx-safe-package/index.cjs');
const originalLoad = Module._load;

// The TypeScript importer historically imports the package name "xlsx". Keep
// its source/API stable while forcing that one tooling process onto the local,
// bounded reader. No code in this process can load the legacy SheetJS module.
Module._load = function potapoffSafeXlsxLoad(request, parent, isMain) {
  if (request === 'xlsx') return safeXlsx;
  return originalLoad.call(this, request, parent, isMain);
};

require('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: {
    module: 'commonjs',
    moduleResolution: 'node',
    esModuleInterop: true,
    allowJs: true,
    resolveJsonModule: true,
  },
});

try {
  require('./import-migration-xlsx.ts');
} finally {
  Module._load = originalLoad;
}
