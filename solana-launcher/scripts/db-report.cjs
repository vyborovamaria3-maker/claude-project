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

require('./db-report.ts');
