'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
require('dotenv').config({path:path.join(__dirname,'..','.env')});
if (process.platform !== 'win32') {
  console.error('This backup entrypoint is for the local Windows laptop.');
  process.exitCode = 1;
} else {
  const runner=spawnSync('powershell.exe',[
    '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
    '-File',path.join(__dirname,'backup-windows.ps1'),
    ...process.argv.slice(2),
  ],{env:process.env,stdio:'inherit',windowsHide:true,shell:false});
  if(runner.error) {
    console.error('Could not start PowerShell backup.');
    process.exitCode=1;
  } else process.exitCode=runner.status ?? 1;
}
