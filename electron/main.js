const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const isDev = !app.isPackaged;
const { SerialPort, ReadlineParser } = require('serialport');

let win;
let serial = { port: null, parser: null };
let intentionalClose = false;   // flag to distinguish programmatic close from cable pull
let lastConnectedPath = null;   // path of the most recently opened port
let lastConnectedBaud = 115200; // baud rate used when last opened
let portWatcherTimer = null;    // setInterval handle for reappearance polling

function stopPortWatcher() {
  if (portWatcherTimer) { clearInterval(portWatcherTimer); portWatcherTimer = null; }
}

function startPortWatcher() {
  stopPortWatcher();
  portWatcherTimer = setInterval(async () => {
    if (!lastConnectedPath) { stopPortWatcher(); return; }
    try {
      const ports = await SerialPort.list();
      if (ports.some(p => p.path === lastConnectedPath)) {
        stopPortWatcher();
        if (win && !win.isDestroyed()) {
          win.webContents.send('serial:port-appeared', { path: lastConnectedPath, baudRate: lastConnectedBaud });
        }
      }
    } catch { /* ignore list errors during polling */ }
  }, 2000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,  // hidden until ready-to-show to avoid flash
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Maximize on every platform; fills the touchscreen on Pi
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
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
  stopPortWatcher(); // stop watching — we're actively connecting now
  lastConnectedPath = portPath;
  lastConnectedBaud = baudRate;
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
      // Native disconnect detection: fires immediately when USB cable is pulled
      port.on('close', () => {
        if (!intentionalClose && serial.port) {
          serial.port = null;
          serial.parser = null;
          if (win && !win.isDestroyed()) win.webContents.send('serial:disconnected');
          startPortWatcher(); // begin polling for port to reappear
        }
      });
      resolve();
    });
  });
  return true;
});

ipcMain.handle('serial:close', async () => {
  if (!serial.port) return true;
  stopPortWatcher(); // operator disconnected intentionally — don't auto-reconnect
  intentionalClose = true;
  await new Promise((resolve) => {
    serial.port.close(() => {
      serial.port = null;
      serial.parser = null;
      intentionalClose = false;
      resolve();
    });
  });
  return true;
});

ipcMain.handle('serial:writeLine', async (e, line) => {
  if (!serial.port) throw new Error('Not connected');
  const sanitized = String(line).trim();
  return new Promise((resolve, reject) => {
    const payload = sanitized + '\r\n';
    serial.port.write(payload, (err) => {
      if (err) reject(err); else resolve(true);
    });
  });
});

ipcMain.handle('serial:sendGcode', async (e, text) => {
  if (!serial.port) throw new Error('Not connected');
  const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (const ln of lines) {
    const sanitized = ln.replace(/[^A-Za-z0-9\s\-\.]/g, '').substring(0, 200);
    if (sanitized && (sanitized.match(/^[GM]\d+/) || sanitized.startsWith(';'))) {
      await new Promise((resolve, reject) => {
        serial.port.write(sanitized + '\r\n', (err) => err ? reject(err) : resolve(true));
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
      serial.port.write(String(ln).trim() + '\r\n', (err) => err ? reject(err) : resolve(true));
    });
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }
  return true;
});

// -------- Job Log IPC --------
ipcMain.handle('fs:saveJobLog', async (e, { filename, content }) => {
  try {
    const logsDir = path.join(app.getPath('documents'), 'GlueJobLogs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const filePath = path.join(logsDir, filename);
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    console.error('fs:saveJobLog failed', err);
    return { ok: false, error: err.message };
  }
});