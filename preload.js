'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('omnipdf', {
  openFile: () => ipcRenderer.invoke('file:open'),
  openPath: (filePath) => ipcRenderer.invoke('file:openPath', filePath),
  save: (payload) => ipcRenderer.invoke('file:save', payload),
  saveAs: (payload) => ipcRenderer.invoke('file:saveAs', payload),
  edit: (payload) => ipcRenderer.invoke('core:edit', payload),
  sign: (payload) => ipcRenderer.invoke('core:sign', payload),
  ocr: (payload) => ipcRenderer.invoke('core:ocr', payload),
  extract: (payload) => ipcRenderer.invoke('core:extract', payload),
  certInfo: () => ipcRenderer.invoke('cert:info'),
  reveal: (filePath) => ipcRenderer.invoke('shell:reveal', filePath),
  appInfo: () => ipcRenderer.invoke('app:info'),
  onMenu: (handler) => {
    const listener = (_event, action) => handler(action);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});
