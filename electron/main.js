const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const isDev = !app.isPackaged;
const { SerialPort, ReadlineParser } = require('serialport');

let win;
let serial = { port: null, parser: null };
let intentionalClose = false;   // flag to distinguish programmatic close from cable pull
let intentionalAppQuit = false; // set to true before app.quit() so the kiosk close-guard lets it through
let lastConnectedPath = null;   // path of the most recently opened port
let lastConnectedBaud = 115200; // baud rate used when last opened
let portWatcherTimer = null;    // setInterval handle for reappearance polling
let keepAliveTimer = null;      // setInterval handle for USB keepalive pings

function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    if (serial.port?.isOpen) {
      serial.port.write('\n', () => {}); // empty newline — Marlin ignores it, prevents Windows USB suspend
    } else {
      stopKeepAlive();
    }
  }, 30000);       // every 30 s — keeps Windows from USB-suspending the port
}

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

// -------- Python Vision Server --------
let visionProcess = null;
let visionReady = false;
let visionStartupError = null; // persisted so renderer can read it after mounting late
let visionErrorHandled = false; // Node fires error then close for the same failure — only report once
let visionHealthPoller = null;  // setInterval for HTTP readiness polling

function markVisionReady() {
  if (visionReady) return;
  visionReady = true;
  visionStartupError = null;
  stopVisionHealthPoller();
  if (win && !win.isDestroyed()) win.webContents.send('vision:ready');
}

function stopVisionHealthPoller() {
  if (visionHealthPoller) { clearInterval(visionHealthPoller); visionHealthPoller = null; }
}

function startVisionHealthPoller() {
  stopVisionHealthPoller();
  let attempts = 0;
  visionHealthPoller = setInterval(() => {
    if (visionReady) { stopVisionHealthPoller(); return; }
    if (++attempts > 20) { // 40 s max
      stopVisionHealthPoller();
      if (!visionReady) {
        visionStartupError = 'Vision server did not respond after 40 s — check Python packages';
        if (win && !win.isDestroyed()) win.webContents.send('vision:stopped', { code: -1, error: visionStartupError });
      }
      return;
    }
    http.get('http://localhost:8000/', (res) => {
      res.resume(); // discard body
      if (res.statusCode < 500) markVisionReady();
    }).on('error', () => { /* not up yet — keep polling */ });
  }, 2000);
}

function startVisionServer() {
  const serverScript = isDev
    ? path.join(__dirname, '..', 'python-vision', 'server.py')
    : path.join(process.resourcesPath, 'python-vision', 'server.py');

  if (!fs.existsSync(serverScript)) {
    console.warn('[Vision] server.py not found at', serverScript);
    visionStartupError = 'server.py not found — check python-vision folder';
    return;
  }

  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  visionErrorHandled = false;
  visionStartupError = null;

  // -u = force unbuffered stdout/stderr so print() output arrives immediately
  visionProcess = spawn(pythonCmd, ['-u', serverScript], {
    cwd: path.dirname(serverScript),
  });

  // Start HTTP polling — most reliable way to detect readiness regardless of buffering
  startVisionHealthPoller();

  visionProcess.stdout.on('data', (data) => {
    const text = data.toString().trim();
    console.log('[Vision]', text);
    if (text.includes('Server ready')) markVisionReady();
  });

  visionProcess.stderr.on('data', (data) => {
    const text = data.toString().trim();
    console.log('[Vision stderr]', text);
    if (text.includes('Application startup complete') || text.includes('Uvicorn running')) markVisionReady();
  });

  // 'error' fires when the executable isn't found (ENOENT) or can't be spawned
  visionProcess.on('error', (err) => {
    console.error('[Vision] Failed to start:', err.message);
    stopVisionHealthPoller();
    visionErrorHandled = true;
    visionReady = false;
    visionProcess = null;
    visionStartupError = err.message;
    if (win && !win.isDestroyed()) win.webContents.send('vision:stopped', { code: -1, error: err.message });
  });

  // 'close' fires after every exit — including after 'error', so guard against double-reporting
  visionProcess.on('close', (code) => {
    console.log(`[Vision] Server exited — code ${code}`);
    stopVisionHealthPoller();
    if (visionErrorHandled) { visionErrorHandled = false; return; }
    const wasReady = visionReady;
    visionReady = false;
    visionProcess = null;
    if (!wasReady && code !== 0 && code !== null) {
      visionStartupError = `Python exited with code ${code} — run: pip install -r requirements.txt`;
    }
    const errMsg = !wasReady ? visionStartupError : null;
    if (win && !win.isDestroyed()) win.webContents.send('vision:stopped', { code, error: errMsg });
  });
}

function stopVisionServer() {
  stopVisionHealthPoller();
  if (visionProcess) {
    visionProcess.kill();
    visionProcess = null;
    visionReady = false;
  }
}

ipcMain.handle('vision:status', () => ({ ready: visionReady, startupError: visionStartupError }));

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,           // hidden until ready-to-show to avoid flash
    // Production kiosk: full-screen, no frame, no title bar
    fullscreen: !isDev,    // true on Pi; false in dev so you keep a normal window
    frame: isDev,          // hide OS window chrome (title bar, close/min/max) on Pi
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: isDev,     // block DevTools access in production
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.once('ready-to-show', () => {
    win.show();
    // In dev keep normal window; on Pi force full-screen and hide cursor
    if (!isDev) {
      win.setAlwaysOnTop(true, 'screen-saver'); // stay above OS overlays
      win.webContents.insertCSS('* { cursor: none !important; }'); // hide mouse cursor for touchscreen
    } else {
      win.maximize();
    }
  });

  // Prevent accidental close on Pi (Alt+F4, OS signals, etc.)
  // Only allow close when intentionalAppQuit is set by the IPC quit handler.
  if (!isDev) {
    app.on('before-quit', () => { intentionalAppQuit = true; });
    win.on('close', (e) => {
      if (!intentionalAppQuit) e.preventDefault();
    });
  }

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();
  if (isDev) {
    // In dev, 'npm run dev' (concurrently) already starts Python separately.
    // Just poll until the server is up — no need to spawn a second instance.
    startVisionHealthPoller();
  } else {
    // In production (Pi packaged build), Electron owns the Python process.
    startVisionServer();
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('will-quit', stopVisionServer);

// Deliberate quit from the in-app Exit button
ipcMain.handle('app:quit', () => { intentionalAppQuit = true; app.quit(); });

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
        stopKeepAlive();
        if (!intentionalClose && serial.port) {
          serial.port = null;
          serial.parser = null;
          if (win && !win.isDestroyed()) win.webContents.send('serial:disconnected');
          startPortWatcher(); // begin polling for port to reappear
        }
      });
      startKeepAlive();
      resolve();
    });
  });
  return true;
});

ipcMain.handle('serial:close', async () => {
  if (!serial.port) return true;
  stopPortWatcher(); // operator disconnected intentionally — don't auto-reconnect
  stopKeepAlive();
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

// ── Fault log ─────────────────────────────────────────────────────────────────
const faultLogPath = () => path.join(app.getPath('documents'), 'GlueJobLogs', 'fault-log.csv');

ipcMain.handle('fs:appendFaultLog', async (e, { entry }) => {
  try {
    const dir = path.join(app.getPath('documents'), 'GlueJobLogs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = faultLogPath();
    const needsHeader = !fs.existsSync(filePath);
    const header = needsHeader ? 'Timestamp,Level,Message\n' : '';
    const row = `"${entry.timestamp}","${entry.level}","${String(entry.message).replace(/"/g, '""')}"\n`;
    fs.appendFileSync(filePath, header + row, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:readFaultLog', async () => {
  try {
    const filePath = faultLogPath();
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.trim().split('\n').slice(1).filter(Boolean); // skip header
    return lines
      .map(line => {
        const m = line.match(/^"([^"]*)","([^"]*)","(.*)"\s*$/);
        if (!m) return null;
        return { timestamp: m[1], level: m[2], message: m[3].replace(/""/g, '"') };
      })
      .filter(Boolean)
      .reverse()   // most recent first
      .slice(0, 500);
  } catch {
    return [];
  }
});

ipcMain.handle('fs:clearFaultLog', async () => {
  try {
    const filePath = faultLogPath();
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
