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
  listSignatures: () => ipcRenderer.invoke('signatures:list'),
  saveSignature: (payload) => ipcRenderer.invoke('signatures:save', payload),
  deleteSignature: (id) => ipcRenderer.invoke('signatures:delete', id),
  reveal: (filePath) => ipcRenderer.invoke('shell:reveal', filePath),
  appInfo: () => ipcRenderer.invoke('app:info'),
  updateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (handler) => {
    const listener = (_event, status) => handler(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
  onMenu: (handler) => {
    const listener = (_event, action) => handler(action);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
  onOpenPaths: (handler) => {
    const listener = (_event, paths) => handler(paths);
    ipcRenderer.on('openPaths', listener);
    return () => ipcRenderer.removeListener('openPaths', listener);
  },
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});
