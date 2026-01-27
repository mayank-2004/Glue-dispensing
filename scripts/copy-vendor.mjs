// scripts/copy-vendor.mjs (Node ESM)
import { copyFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const vendorDir = join(__dirname, '..', 'public', 'vendor');
await mkdir(vendorDir, { recursive: true });

// Copy UMD builds so app works offline
const copies = [
  {
    from: join(__dirname, '..', 'node_modules', 'whats-that-gerber', 'dist', 'whats-that-gerber.min.js'),
    to: join(vendorDir, 'whats-that-gerber.min.js')
  },
  {
    from: join(__dirname, '..', 'node_modules', 'pcb-stackup', 'dist', 'pcb-stackup.min.js'),
    to: join(vendorDir, 'pcb-stackup.min.js')
  }
];

for (const { from, to } of copies) {
  try {
    await copyFile(from, to);
    console.log('Copied', from, '->', to);
  } catch (e) {
    console.warn('Failed to copy', from, e.message);
  }
}
