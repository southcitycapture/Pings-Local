import { contextBridge, ipcRenderer } from 'electron'

const api = {
    // Ping
    onStartPulse: (callback) => ipcRenderer.on('start-pulse', (_event, ...args) => callback(...args)),
    onPeersUpdated: (callback) => ipcRenderer.on('peers-updated', (_event, ...args) => callback(...args)),
    sendPing: (ip, peerName, message) => ipcRenderer.send('trigger-ping', ip, peerName, message),
    
    // Settings
    updateSetting: (key, value) => ipcRenderer.send('update-setting', { key, value }),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    onSettingsUpdated: (callback) => ipcRenderer.on('settings-updated', (_event, ...args) => callback(...args)),
    onSoundChanged: (callback) => ipcRenderer.on('sound-changed', (_event, ...args) => callback(...args)),
    
    // Profile
    getProfile: () => ipcRenderer.invoke('get-profile'),
    setProfile: (profile) => ipcRenderer.send('set-profile', profile),
    
    // History
    getHistory: () => ipcRenderer.invoke('get-history'),
    clearHistory: () => ipcRenderer.send('clear-history'),
    onHistoryUpdated: (callback) => ipcRenderer.on('history-updated', (_event, ...args) => callback(...args)),
    
    // Network
    onNetworkStatus: (callback) => ipcRenderer.on('network-status', (_event, ...args) => callback(...args)),
    getNetworkInterfaces: () => ipcRenderer.invoke('get-network-interfaces'),
    
    // Group Chat
    sendChatMessage: (text) => ipcRenderer.send('send-chat-message', text),
    sendTyping: () => ipcRenderer.send('send-typing'),
    onChatMessage: (callback) => ipcRenderer.on('chat-message', (_event, ...args) => callback(...args)),
    onChatTyping: (callback) => ipcRenderer.on('chat-typing', (_event, ...args) => callback(...args)),
    onChatPeersUpdated: (callback) => ipcRenderer.on('chat-peers-updated', (_event, ...args) => callback(...args)),
    
    // Private Chat
    sendPrivateMessage: (toIp, text) => ipcRenderer.send('send-private-message', { toIp, text }),
    sendPrivateTyping: (toIp) => ipcRenderer.send('send-private-typing', toIp),
    onPrivateMessage: (callback) => ipcRenderer.on('private-message', (_event, ...args) => callback(...args)),
    onPrivateTyping: (callback) => ipcRenderer.on('private-typing', (_event, ...args) => callback(...args)),
    onPrivateMessageStatus: (callback) => ipcRenderer.on('private-message-status', (_event, ...args) => callback(...args)),
    openPrivateChat: (peerIp, peerName, peerColor, peerAvatar) => ipcRenderer.send('open-private-chat', { peerIp, peerName, peerColor, peerAvatar }),
    getPeerData: () => ipcRenderer.invoke('get-peer-data'),
    getPrivateChatHistory: (targetIp) => ipcRenderer.invoke('get-private-chat-history', targetIp),
    onPrivateHistory: (callback) => ipcRenderer.on('private-history', (_event, ...args) => callback(...args)),

    // Onboarding
    completeOnboarding: (profile) => ipcRenderer.send('complete-onboarding', profile)
}

if (process.contextIsolated) {
    try { contextBridge.exposeInMainWorld('api', api) } catch (error) { console.error(error) }
} else {
    window.api = api
}
