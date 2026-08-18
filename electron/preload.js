const { contextBridge, ipcRenderer } = require('electron');

// ── App Control ──────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('appControl', {
  quit: () => ipcRenderer.invoke('app:quit'),
});

// ── File System ──────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('fs', {
  saveJobLog:     (opts)  => ipcRenderer.invoke('fs:saveJobLog', opts),
  appendFaultLog: (entry) => ipcRenderer.invoke('fs:appendFaultLog', { entry }),
  readFaultLog:   ()      => ipcRenderer.invoke('fs:readFaultLog'),
  clearFaultLog:  ()      => ipcRenderer.invoke('fs:clearFaultLog'),
});

// ── Vision Server ────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('vision', {
  status:    () => ipcRenderer.invoke('vision:status'),
  onReady:   (handler) => { const s = ()       => handler();   ipcRenderer.on('vision:ready',   s); return () => ipcRenderer.removeListener('vision:ready',   s); },
  onStopped: (handler) => { const s = (_e, d)  => handler(d); ipcRenderer.on('vision:stopped', s); return () => ipcRenderer.removeListener('vision:stopped', s); },
});

// ── Serial Port ──────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('serial', {
  list:      ()                     => ipcRenderer.invoke('serial:list'),
  open:      (opts)                 => ipcRenderer.invoke('serial:open', opts),
  close:     ()                     => ipcRenderer.invoke('serial:close'),
  writeLine: (line)                 => ipcRenderer.invoke('serial:writeLine', line),
  sendGcode: (text)                 => ipcRenderer.invoke('serial:sendGcode', text),
  writeMany: (lines, delayMs = 3)   => ipcRenderer.invoke('serial:writeMany', { lines, delayMs }),
  onData: (handler) => {
    const subscription = (_evt, line) => handler(line);
    ipcRenderer.on('serial:data', subscription);
    return () => ipcRenderer.removeListener('serial:data', subscription);
  },
  onDisconnect: (handler) => {
    const subscription = () => handler();
    ipcRenderer.on('serial:disconnected', subscription);
    return () => ipcRenderer.removeListener('serial:disconnected', subscription);
  },
  onPortAppeared: (handler) => {
    const subscription = (_evt, info) => handler(info);
    ipcRenderer.on('serial:port-appeared', subscription);
    return () => ipcRenderer.removeListener('serial:port-appeared', subscription);
  },
});

// ── Runtime Environment Flag ─────────────────────────────────────────────────
// Remote browsers (iPad/tablet) won't have this — used to switch between
// IPC mode (Electron) and WebSocket mode (remote browser).
contextBridge.exposeInMainWorld('isElectron', true);

// ── Network / OS Configuration ───────────────────────────────────────────────
// Wraps nmcli (Wi-Fi) and bluetoothctl (Bluetooth) via Electron main IPC.
// Only meaningful on Linux / Raspberry Pi OS. On Windows these gracefully
// return { ok: false, error: 'not supported' } from main.js.
contextBridge.exposeInMainWorld('network', {
  scanWifi:         ()     => ipcRenderer.invoke('network:scanWifi'),
  connectWifi:      (opts) => ipcRenderer.invoke('network:connectWifi', opts),
  disconnectWifi:   ()     => ipcRenderer.invoke('network:disconnectWifi'),
  getWifiStatus:    ()     => ipcRenderer.invoke('network:getWifiStatus'),
  getLocalIp:       ()     => ipcRenderer.invoke('network:getLocalIp'),
  scanBluetooth:    ()     => ipcRenderer.invoke('network:scanBluetooth'),
  connectBluetooth: (opts) => ipcRenderer.invoke('network:connectBluetooth', opts),
  getPairedDevices: ()     => ipcRenderer.invoke('network:getPairedDevices'),
});
