const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fs', {
  saveJobLog: (opts) => ipcRenderer.invoke('fs:saveJobLog', opts),
});

contextBridge.exposeInMainWorld('vision', {
  status: () => ipcRenderer.invoke('vision:status'),
  onReady:   (handler) => { const s = () => handler();         ipcRenderer.on('vision:ready',   s); return () => ipcRenderer.removeListener('vision:ready',   s); },
  onStopped: (handler) => { const s = (_e, d) => handler(d);  ipcRenderer.on('vision:stopped', s); return () => ipcRenderer.removeListener('vision:stopped', s); },
});

contextBridge.exposeInMainWorld('serial', {
    list: () => ipcRenderer.invoke('serial:list'),
    open: (opts) => ipcRenderer.invoke('serial:open', opts),
    close: () => ipcRenderer.invoke('serial:close'),
    writeLine: (line) => ipcRenderer.invoke('serial:writeLine', line),
    sendGcode: (text) => ipcRenderer.invoke('serial:sendGcode', text),
    writeMany: (lines, delayMs = 3) => ipcRenderer.invoke('serial:writeMany', { lines, delayMs }),
    onData: (handler) => {
        // Allow multiple listeners
        const subscription = (_evt, line) => handler(line);
        ipcRenderer.on('serial:data', subscription);
        return () => ipcRenderer.removeListener('serial:data', subscription);
    },
    onDisconnect: (handler) => {
        // Fires when USB cable is pulled (native SerialPort 'close' event)
        const subscription = () => handler();
        ipcRenderer.on('serial:disconnected', subscription);
        return () => ipcRenderer.removeListener('serial:disconnected', subscription);
    },
    onPortAppeared: (handler) => {
        // Fires when the last-used port reappears after a cable pull
        const subscription = (_evt, info) => handler(info);
        ipcRenderer.on('serial:port-appeared', subscription);
        return () => ipcRenderer.removeListener('serial:port-appeared', subscription);
    }
});
