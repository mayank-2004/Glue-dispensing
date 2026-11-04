import { spawn } from 'child_process';
import path from 'path';

const isWin = process.platform === 'win32';
const cmd = isWin ? 'pip' : 'pip3';
const dir = path.join(process.cwd(), 'python-vision');

const p = spawn(cmd, ['install', '-r', 'requirements.txt'], { stdio: 'inherit', cwd: dir });
p.on('exit', (code) => process.exit(code ?? 0));

