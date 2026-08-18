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

// When the app closes, send M410 (Quickstop) to halt any active motion (e.g. mid-homing)
// then cleanly close the serial port before letting Electron exit.
let serialStopDone = false;
app.on('before-quit', async (e) => {
  if (serialStopDone || !serial.port?.isOpen) return;
  e.preventDefault();
  serialStopDone = true;
  try {
    await new Promise((res, rej) =>
      serial.port.write('M410\r\n', err => err ? rej(err) : res())
    );
    await new Promise(r => setTimeout(r, 150)); // give Marlin time to halt
  } catch {}
  try {
    stopKeepAlive();
    stopPortWatcher();
    intentionalClose = true;
    await new Promise(r => serial.port.close(() => r()));
    serial.port = null;
    serial.parser = null;
    intentionalClose = false;
  } catch {}
  app.quit();
});

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

// ── Network / OS Management ───────────────────────────────────────────────────
// Uses child_process.exec to call standard Linux CLI tools (nmcli, bluetoothctl).
// On Windows all handlers return { ok: false, error: 'not supported on Windows' }
// so the app continues to work on Windows dev machines without crashing.
const { exec } = require('child_process');
const os       = require('os');

function runCmd(cmd) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      return resolve({ ok: false, error: 'not supported on Windows' });
    }
    exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: stderr || err.message, stdout });
      else     resolve({ ok: true, stdout: stdout.trim() });
    });
  });
}

// --- Wi-Fi (nmcli) ---

// Returns list of visible Wi-Fi networks: [{ ssid, signal, security, active }]
ipcMain.handle('network:scanWifi', async () => {
  const r = await runCmd('nmcli -t -f SSID,SIGNAL,SECURITY,ACTIVE device wifi list');
  if (!r.ok) return r;
  const networks = r.stdout
    .split('\n')
    .map(line => {
      const [ssid, signal, security, active] = line.split(':');
      return ssid ? { ssid, signal: parseInt(signal) || 0, security: security || '', active: active === 'yes' } : null;
    })
    .filter(Boolean)
    .filter((n, i, arr) => arr.findIndex(x => x.ssid === n.ssid) === i); // deduplicate
  return { ok: true, networks };
});

// Connects to a given SSID with optional password
ipcMain.handle('network:connectWifi', async (_e, { ssid, password }) => {
  if (!ssid) return { ok: false, error: 'No SSID provided' };
  const cmd = password
    ? `nmcli device wifi connect "${ssid}" password "${password}"`
    : `nmcli device wifi connect "${ssid}"`;
  return runCmd(cmd);
});

// Disconnects the active Wi-Fi connection
ipcMain.handle('network:disconnectWifi', async () => {
  return runCmd('nmcli device disconnect wlan0');
});

// Returns current Wi-Fi connection info: { connected, ssid, ip }
ipcMain.handle('network:getWifiStatus', async () => {
  const r = await runCmd('nmcli -t -f ACTIVE,SSID,IP4.ADDRESS device show wlan0');
  if (!r.ok) {
    // Fallback: try to get IP via os.networkInterfaces
    const ip = getLocalIpAddress();
    return { ok: true, connected: !!ip, ssid: '', ip };
  }
  const lines  = r.stdout.split('\n');
  const find   = (key) => (lines.find(l => l.startsWith(key)) || '').split(':').slice(1).join(':').trim();
  const active = find('GENERAL.CONNECTION') !== '--' && find('GENERAL.CONNECTION') !== '';
  const ssid   = find('GENERAL.CONNECTION');
  const ip     = (find('IP4.ADDRESS[1]') || '').split('/')[0];
  return { ok: true, connected: active, ssid, ip };
});

// --- Local IP (cross-platform fallback) ---
function getLocalIpAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

ipcMain.handle('network:getLocalIp', async () => {
  // Try nmcli first on Linux for the wlan0 interface
  if (process.platform !== 'win32') {
    const r = await runCmd("nmcli -t -f IP4.ADDRESS dev show wlan0");
    if (r.ok && r.stdout) {
      const ip = r.stdout.split('\n')
        .map(l => l.split(':').slice(1).join(':').trim().split('/')[0])
        .find(s => s && s !== '--');
      if (ip) return { ok: true, ip };
    }
  }
  const ip = getLocalIpAddress();
  return ip ? { ok: true, ip } : { ok: false, error: 'No active network interface found' };
});

// --- Bluetooth (bluetoothctl) ---

// Starts a 6-second scan and returns discovered devices: [{ mac, name, paired }]
ipcMain.handle('network:scanBluetooth', async () => {
  // Start scan for 6 s then list devices
  await runCmd('bluetoothctl --timeout 6 scan on');
  const r = await runCmd('bluetoothctl devices');
  if (!r.ok) return r;
  const devices = r.stdout
    .split('\n')
    .map(line => {
      const m = line.match(/^Device ([0-9A-F:]{17}) (.+)$/i);
      return m ? { mac: m[1], name: m[2].trim(), paired: false } : null;
    })
    .filter(Boolean);
  // Check which ones are paired
  const pairedR = await runCmd('bluetoothctl paired-devices');
  if (pairedR.ok) {
    const pairedMacs = new Set(pairedR.stdout.split('\n').map(l => { const m = l.match(/([0-9A-F:]{17})/i); return m ? m[1] : null; }).filter(Boolean));
    devices.forEach(d => { d.paired = pairedMacs.has(d.mac); });
  }
  return { ok: true, devices };
});

// Pairs and connects to a Bluetooth device by MAC address
ipcMain.handle('network:connectBluetooth', async (_e, { mac }) => {
  if (!mac) return { ok: false, error: 'No MAC address provided' };
  const pair    = await runCmd(`bluetoothctl pair ${mac}`);
  const connect = await runCmd(`bluetoothctl connect ${mac}`);
  return connect.ok ? connect : pair;
});

// Returns already-paired Bluetooth devices
ipcMain.handle('network:getPairedDevices', async () => {
  const r = await runCmd('bluetoothctl paired-devices');
  if (!r.ok) return r;
  const devices = r.stdout.split('\n')
    .map(line => { const m = line.match(/^Device ([0-9A-F:]{17}) (.+)$/i); return m ? { mac: m[1], name: m[2].trim(), paired: true } : null; })
    .filter(Boolean);
  return { ok: true, devices };
});

// ── Fleet HTTP Server ─────────────────────────────────────────────────────────
// Serves the compiled React app and forwards serial data to remote browsers.
// Port 8080. Only active in packaged production builds (not during npm run dev).
const FLEET_PORT = 8080;

function startFleetServer() {
  const httpMod = require('http');
  const pathMod = require('path');
  const fsMod   = require('fs');
  const distDir = pathMod.join(__dirname, '..', 'dist');

  const mimeTypes = {
    '.html': 'text/html', '.js': 'application/javascript',
    '.css': 'text/css',   '.svg': 'image/svg+xml',
    '.png': 'image/png',  '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
  };

  // Lightweight WebSocket upgrade handler (no external deps)
  const wsClients = new Set();

  function wsHandshake(req, socket, head) {
    const key  = req.headers['sec-websocket-key'];
    const hash = require('crypto').createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${hash}`, '', ''
    ].join('\r\n'));

    wsClients.add(socket);
    socket.on('close', () => wsClients.delete(socket));
    socket.on('error', () => wsClients.delete(socket));

    // Forward incoming WS frames to the serial port
    socket.on('data', (buf) => {
      try {
        const opcode = buf[0] & 0x0f;
        if (opcode !== 1) return; // only text frames
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
        const mask = masked ? buf.slice(offset, offset + 4) : null;
        if (masked) offset += 4;
        const payload = buf.slice(offset, offset + len);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        const text = payload.toString('utf8').trim();
        if (text && serial.port?.isOpen) serial.port.write(text + '\r\n', () => {});
      } catch {}
    });
  }

  function wsSend(socket, text) {
    try {
      const data  = Buffer.from(text, 'utf8');
      const frame = Buffer.allocUnsafe(data.length < 126 ? 2 + data.length : 4 + data.length);
      frame[0] = 0x81; // FIN + text opcode
      if (data.length < 126) { frame[1] = data.length; data.copy(frame, 2); }
      else                   { frame[1] = 126; frame.writeUInt16BE(data.length, 2); data.copy(frame, 4); }
      socket.write(frame);
    } catch {}
  }

  // Broadcast serial data to all connected WS clients
  if (serial.parser) {
    serial.parser.on('data', (line) => wsClients.forEach(s => wsSend(s, line)));
  }

  const server = httpMod.createServer((req, res) => {
    // Serve static files from dist/
    let filePath = pathMod.join(distDir, req.url === '/' ? 'index.html' : req.url);
    const ext = pathMod.extname(filePath);
    if (!fsMod.existsSync(filePath)) filePath = pathMod.join(distDir, 'index.html'); // SPA fallback
    const mime = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    fsMod.createReadStream(filePath).pipe(res);
  });

  server.on('upgrade', wsHandshake);
  server.listen(FLEET_PORT, '0.0.0.0', () => {
    console.log(`[Fleet] HTTP server running on port ${FLEET_PORT}`);
  });
}

// Start fleet server only in production (packaged) builds
if (!isDev) startFleetServer();

