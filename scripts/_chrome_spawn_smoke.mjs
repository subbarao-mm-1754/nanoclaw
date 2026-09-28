import { spawn } from 'child_process';

const p = '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';
const c = spawn(p, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
c.on('error', (e) => {
  console.error('ERR', e);
  process.exit(1);
});
c.stdout?.on('data', (d) => console.log(String(d)));
c.stderr?.on('data', (d) => console.error(String(d)));
c.on('exit', (code) => {
  console.log('exit', code);
  process.exit(code || 0);
});
