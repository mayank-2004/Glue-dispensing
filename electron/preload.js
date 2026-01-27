const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serial', {
    list: () => ipcRenderer.invoke('serial:list'),
    open: (opts) => ipcRenderer.invoke('serial:open', opts),
    close: () => ipcRenderer.invoke('serial:close'),
    writeLine: (line) => ipcRenderer.invoke('serial:writeLine', line),
    sendGcode: (text) => ipcRenderer.invoke('serial:sendGcode', text),
    writeMany: (lines, delayMs = 3) => ipcRenderer.invoke('serial:writeMany', { lines, delayMs }),
    onData: (handler) => {
        ipcRenderer.removeAllListeners('serial:data');
        ipcRenderer.on('serial:data', (_evt, line) => handler(line));
        return () => ipcRenderer.removeListener('serial:data');
    }
});
