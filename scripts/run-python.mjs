import { spawn } from 'child_process';
import path from 'path';

const isWin = process.platform === 'win32';
const cmd = isWin ? 'python' : 'python3';
const dir = path.join(process.cwd(), 'python-vision');
const script = path.join(dir, 'server.py');

// Forward output, but filter harmless libjpeg hardware padding logs from stdout and stderr
const p = spawn(cmd, ['-u', script], {
  stdio: ['inherit', 'pipe', 'pipe'],
  cwd: dir
});

p.stdout.on('data', (chunk) => {
  const lines = chunk.toString().split('\n');
  for (const line of lines) {
    if (line.includes('Corrupt JPEG data') || line.includes('Premature end of JPEG')) continue;
    if (line.trim()) process.stdout.write(line + '\n');
  }
});

p.stderr.on('data', (chunk) => {
  const lines = chunk.toString().split('\n');
  for (const line of lines) {
    if (line.includes('Corrupt JPEG data') || line.includes('Premature end of JPEG')) continue;
    if (line.trim()) process.stderr.write(line + '\n');
  }
});

p.on('exit', (code) => process.exit(code ?? 0));
