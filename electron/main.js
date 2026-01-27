const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const isDev = !app.isPackaged;
const { SerialPort, ReadlineParser } = require('serialport');

let win;
let serial = { port: null, parser: null };

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// -------- Serial IPC --------
ipcMain.handle('serial:list', async () => {
  try {
    const ports = await SerialPort.list();
    const norm = ports
      .map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || '',
        serialNumber: p.serialNumber || '',
        productId: p.productId || '',
        vendorId: p.vendorId || '',
        friendly: [p.path, p.manufacturer, p.serialNumber].filter(Boolean).join(' — '),
      }))
    // .filter(p => p.path); // only keep valid entries
    return norm;
  } catch (e) {
    console.error('serial:list failed', e);
    return [];
  }
});

ipcMain.handle('serial:open', async (e, { path: portPath, baudRate = 115200 }) => {
  if (!portPath || typeof portPath !== 'string') {
    throw new Error('No serial "path" provided. Pick a port before connecting.');
  }
  // close previous if open
  if (serial.port?.isOpen) {
    await new Promise(r => serial.port.close(() => r()));
  }
  await new Promise((resolve, reject) => {
    const port = new SerialPort({ path: portPath, baudRate }, (err) => {
      if (err) return reject(err);
      serial.port = port;
      serial.parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
      serial.parser.on('data', (line) => {
        win.webContents.send('serial:data', line.toString());
      });
      resolve();
    });
  });
  return true;
});

ipcMain.handle('serial:close', async () => {
  if (!serial.port) return true;
  await new Promise((resolve) => {
    serial.port.close(() => {
      serial.port = null;
      serial.parser = null;
      resolve();
    });
  });
  return true;
});

ipcMain.handle('serial:writeLine', async (e, line) => {
  if (!serial.port) throw new Error('Not connected');
  // Sanitize input - only allow G-code commands
  const sanitized = String(line).replace(/[^A-Za-z0-9\s\-\.]/g, '').substring(0, 200);
  if (!sanitized.match(/^[GM]\d+/)) throw new Error('Invalid G-code command');
  return new Promise((resolve, reject) => {
    serial.port.write(sanitized.endsWith('\n') ? sanitized : (sanitized + '\n'), (err) => {
      if (err) reject(err); else resolve(true);
    });
  });
});

ipcMain.handle('serial:sendGcode', async (e, text) => {
  if (!serial.port) throw new Error('Not connected');
  const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (const ln of lines) {
    // Sanitize each line
    const sanitized = ln.replace(/[^A-Za-z0-9\s\-\.]/g, '').substring(0, 200);
    if (sanitized && (sanitized.match(/^[GM]\d+/) || sanitized.startsWith(';'))) {
      await new Promise((resolve, reject) => {
        serial.port.write(sanitized + '\n', (err) => err ? reject(err) : resolve(true));
      });
      await new Promise(r => setTimeout(r, 2));
    }
  }
  return true;
});

ipcMain.handle('serial:writeMany', async (e, { lines = [], delayMs = 3 }) => {
  if (!serial.port) throw new Error('Not connected');
  for (const ln of lines) {
    await new Promise((resolve, reject) => {
      serial.port.write(String(ln).trim() + '\n', (err) => err ? reject(err) : resolve(true));
    });
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }
  return true;
})