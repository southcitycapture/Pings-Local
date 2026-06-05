import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { Networking } from './networking.js'
import { readFileSync, writeFileSync, existsSync } from 'fs'

let tray = null
let overlayWindow = null
let dashboardWindow = null
let onboardingWindow = null
let privateChatWindows = new Map() // peerIp -> BrowserWindow
let pendingPrivateMessages = new Map() // peerIp -> message[]
let networking = null
let settings = { 
    position: 'top-right', 
    sound: 'chime', 
    dnd: false, 
    customMessage: '',
    pingShape: 'circle',
    preferredIp: '',
    discoveryNodeIp: '',
    peerSounds: {},
    quickReplies: ['On my way!', 'Be there in 5', 'Thanks!', 'Got it', 'One moment'],
    hasCompletedOnboarding: false
}
let pingHistory = []
const MAX_HISTORY = 20
const PRIVATE_CHAT_WINDOW = { width: 380, height: 500 }
const PRIVATE_CHAT_CASCADE_OFFSET = 28
const PING_SHAPES = new Set(['circle', 'square', 'diamond', 'border'])

const profilePath = join(app.getPath('userData'), 'profile.json')

function loadProfile() {
    try {
        if (existsSync(profilePath)) {
            return JSON.parse(readFileSync(profilePath, 'utf-8'))
        }
    } catch { }
    return { displayName: '', avatarColor: '', pingSound: 'chime', status: 'online', avatar: null }
}

function loadSettings() {
    try {
        const settingsPath = join(app.getPath('userData'), 'settings.json')
        if (existsSync(settingsPath)) {
            return { ...settings, ...JSON.parse(readFileSync(settingsPath, 'utf-8')) }
        }
    } catch { }
    return settings
}

function saveSettings(newSettings) {
    settings = { ...settings, ...newSettings }
    writeFileSync(join(app.getPath('userData'), 'settings.json'), JSON.stringify(settings, null, 2))
}

function saveProfile(profile) {
    writeFileSync(profilePath, JSON.stringify(profile, null, 2))
}

function addToHistory(entry) {
    pingHistory.unshift({ ...entry, timestamp: Date.now() })
    if (pingHistory.length > MAX_HISTORY) pingHistory = pingHistory.slice(0, MAX_HISTORY)
    try { writeFileSync(join(app.getPath('userData'), 'history.json'), JSON.stringify(pingHistory, null, 2)) } catch { }
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.webContents.send('history-updated', pingHistory)
    }
}

function loadHistory() {
    try {
        const historyPath = join(app.getPath('userData'), 'history.json')
        if (existsSync(historyPath)) pingHistory = JSON.parse(readFileSync(historyPath, 'utf-8'))
    } catch { }
    return pingHistory
}

function getNetworkStatusPayload() {
    if (!networking) return { ip: '127.0.0.1', hostname: 'offline', preferredIp: settings.preferredIp || '', discoveryNodeIp: settings.discoveryNodeIp || '' }
    return {
        ip: networking.localIp || networking.getLocalIp(),
        hostname: networking.displayName,
        preferredIp: settings.preferredIp || '',
        discoveryNodeIp: settings.discoveryNodeIp || '',
        diagnostics: networking.getDiagnostics()
    }
}

function mergePeers(discoveryPeers = [], chatPeers = []) {
    const merged = new Map()
    for (const peer of discoveryPeers) {
        merged.set(peer.ip, { ...peer })
    }
    for (const peer of chatPeers) {
        const existing = merged.get(peer.ip) || {}
        merged.set(peer.ip, {
            ...existing,
            ip: peer.ip,
            name: peer.name || existing.name || peer.ip,
            color: existing.color || peer.color,
            lastSeen: existing.lastSeen || peer.lastSeen || Date.now()
        })
    }
    return Array.from(merged.values())
}

// --- Windows ---

function createOnboardingWindow() {
    onboardingWindow = new BrowserWindow({
        width: 420, height: 480, show: false, autoHideMenuBar: true,
        titleBarStyle: 'hiddenInset', resizable: false,
        webPreferences: { preload: join(__dirname, '../preload/index.mjs'), sandbox: false, contextIsolation: true }
    })
    onboardingWindow.on('ready-to-show', () => onboardingWindow.show())
    onboardingWindow.on('closed', () => onboardingWindow = null)
    onboardingWindow.center()
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        onboardingWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/onboarding.html`)
    } else {
        onboardingWindow.loadFile(join(__dirname, '../renderer/onboarding.html'))
    }
}

function createDashboardWindow() {
    dashboardWindow = new BrowserWindow({
        width: 900, height: 700, show: false, autoHideMenuBar: true,
        titleBarStyle: 'hiddenInset', minWidth: 800, minHeight: 600,
        webPreferences: { preload: join(__dirname, '../preload/index.mjs'), sandbox: false, contextIsolation: true }
    })
    dashboardWindow.on('ready-to-show', () => dashboardWindow.show())
    dashboardWindow.webContents.on('did-finish-load', () => {
        if (networking) {
            const peers = mergePeers(Array.from(networking.peers.values()), Array.from(networking.chatPeers?.values() || []))
            dashboardWindow.webContents.send('peers-updated', peers)
            dashboardWindow.webContents.send('network-status', getNetworkStatusPayload())
            dashboardWindow.webContents.send('settings-updated', settings)
            dashboardWindow.webContents.send('history-updated', loadHistory())
            dashboardWindow.webContents.send('chat-peers-updated', Array.from(networking.chatPeers?.values() || []))
        }
    })
    dashboardWindow.on('closed', () => { dashboardWindow = null })
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        dashboardWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/dashboard.html`)
    } else {
        dashboardWindow.loadFile(join(__dirname, '../renderer/dashboard.html'))
    }
}

function createPrivateChatWindow(peerIp, peerName, peerColor, peerAvatar = null) {
    // Check if window already exists
    if (privateChatWindows.has(peerIp)) {
        const existingWindow = privateChatWindows.get(peerIp)
        if (!existingWindow.isDestroyed()) {
            existingWindow.show()
            existingWindow.focus()
            return
        }
    }

    const chatWindow = new BrowserWindow({
        width: PRIVATE_CHAT_WINDOW.width, height: PRIVATE_CHAT_WINDOW.height, show: false, autoHideMenuBar: true,
        titleBarStyle: 'hiddenInset', resizable: true, minWidth: 300, minHeight: 400,
        alwaysOnTop: true,
        webPreferences: { preload: join(__dirname, '../preload/index.mjs'), sandbox: false, contextIsolation: true }
    })

    const { workArea } = screen.getPrimaryDisplay()
    const openWindows = Array.from(privateChatWindows.values()).filter(win => !win.isDestroyed()).length
    const x = Math.max(workArea.x, workArea.x + workArea.width - PRIVATE_CHAT_WINDOW.width - 24 - (openWindows * PRIVATE_CHAT_CASCADE_OFFSET))
    const y = Math.max(workArea.y, workArea.y + workArea.height - PRIVATE_CHAT_WINDOW.height - 40 - (openWindows * PRIVATE_CHAT_CASCADE_OFFSET))
    chatWindow.setPosition(x, y)
    chatWindow.setAlwaysOnTop(true, 'floating')
    chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    chatWindow.on('ready-to-show', () => {
        chatWindow.show()
        chatWindow.focus()
    })
    chatWindow.webContents.on('did-finish-load', () => {
        const pending = pendingPrivateMessages.get(peerIp) || []
        pending.forEach((msg) => chatWindow.webContents.send('private-message', msg))
        pendingPrivateMessages.delete(peerIp)
    })
    chatWindow.on('closed', () => {
        privateChatWindows.delete(peerIp)
        pendingPrivateMessages.delete(peerIp)
    })
    
    // Store peer info to pass to renderer
    chatWindow.peerData = { ip: peerIp, name: peerName, color: peerColor, avatar: peerAvatar, localIp: networking?.localIp || null }
    
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        chatWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/private-chat.html`)
    } else {
        chatWindow.loadFile(join(__dirname, '../renderer/private-chat.html'))
    }
    
    privateChatWindows.set(peerIp, chatWindow)
}

function createOverlayWindow() {
    const primaryDisplay = screen.getPrimaryDisplay()
    const { x, y, width, height } = primaryDisplay.bounds
    
    overlayWindow = new BrowserWindow({
        x, y, width, height, frame: false, transparent: true, alwaysOnTop: true,
        focusable: false, fullscreenable: false,
        resizable: false, movable: false, hasShadow: false, skipTaskbar: true,
        webPreferences: { preload: join(__dirname, '../preload/index.mjs'), sandbox: false, contextIsolation: true }
    })
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    overlayWindow.setIgnoreMouseEvents(true)
    overlayWindow.setBackgroundColor('#00000000')

    const savedSettings = loadSettings()
    setPosition(savedSettings.position || 'top-right')

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        overlayWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
        overlayWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
    overlayWindow.hide()
}

// --- Tray ---

function updateTrayMenu(peers = []) {
    if (!tray) return
    const peerItems = peers.map(peer => ({
        label: `Ping ${peer.name}`,
        click: () => {
            const soundOverride = settings.peerSounds?.[peer.ip] || null
            networking.sendPing(peer.ip, settings.customMessage || '', soundOverride, settings.pingShape)
            addToHistory({ type: 'sent', peerName: peer.name, peerIp: peer.ip, message: settings.customMessage })
        }
    }))
    const template = [
        { label: 'Pings', enabled: false },
        { label: 'Open Dashboard', click: () => (dashboardWindow ? dashboardWindow.show() : createDashboardWindow()) },
        { type: 'separator' },
        ...peerItems,
        ...(peerItems.length > 0 ? [{ type: 'separator' }] : []),
        { label: 'Quit', click: () => app.quit() }
    ]
    tray.setContextMenu(Menu.buildFromTemplate(template))
}

function setPosition(pos) {
    if (!overlayWindow) return
    const activeDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay()
    const { x: displayX, y: displayY, width, height } = activeDisplay.bounds
    
    if (pos === 'border') {
        overlayWindow.setBounds({ x: displayX, y: displayY, width, height })
        return
    }

    const windowWidth = 400, windowHeight = 400
    let x, y
    switch (pos) {
        case 'top-left': x = displayX; y = displayY; break
        case 'top-right': x = displayX + width - windowWidth; y = displayY; break
        case 'center': x = displayX + Math.round((width - windowWidth) / 2); y = displayY + Math.round((height - windowHeight) / 2); break
        default: x = displayX + width - windowWidth; y = displayY
    }
    overlayWindow.setResizable(false)
    overlayWindow.setBounds({ x, y, width: windowWidth, height: windowHeight })
}

function getTrayIcon() {
    const iconPath = is.dev ? join(__dirname, '../../resources/tray-icon.png') : join(process.resourcesPath, 'tray-icon.png')
    if (existsSync(iconPath)) return nativeImage.createFromPath(iconPath)
    
    const size = 16, canvas = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = x - size/2 + 0.5, dy = y - size/2 + 0.5
            const dist = Math.sqrt(dx*dx + dy*dy)
            const idx = (y * size + x) * 4
            if (dist < 6) { canvas[idx] = 140; canvas[idx+1] = 90; canvas[idx+2] = 220; canvas[idx+3] = 255 }
            else canvas[idx+3] = 0
        }
    }
    return nativeImage.createFromBuffer(canvas, { width: size, height: size })
}

function createTray() {
    tray = new Tray(getTrayIcon())
    tray.setToolTip('Pings')
    updateTrayMenu()
    tray.on('click', () => (dashboardWindow ? dashboardWindow.show() : createDashboardWindow()))
}

// --- App Lifecycle ---

app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.pings.app')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    settings = loadSettings()
    const profile = loadProfile()

    if (!settings.hasCompletedOnboarding || !profile.displayName) {
        createOnboardingWindow()
    } else {
        startApp()
    }
})

function startApp() {
    createOverlayWindow()
    createTray()
    createDashboardWindow()

    const profile = loadProfile()
    networking = new Networking(app)
    networking.setPreferredIp(settings.preferredIp || '')
    networking.setDiscoveryNodeIp(settings.discoveryNodeIp || '')
    if (profile.displayName) networking.setDisplayName(profile.displayName)
    networking.setProfile(profile)
    networking.start()

    // Events
    app.on('peers-updated', (peers) => {
        const mergedPeers = mergePeers(peers, Array.from(networking.chatPeers?.values() || []))
        if (!settings.dnd) updateTrayMenu(mergedPeers)
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
            dashboardWindow.webContents.send('peers-updated', settings.dnd ? mergedPeers.map(p => ({...p, muted: true})) : mergedPeers)
            dashboardWindow.webContents.send('network-status', getNetworkStatusPayload())
            dashboardWindow.webContents.send('settings-updated', settings)
        }
    })

    app.on('chat-peers-updated', (peers) => {
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
            dashboardWindow.webContents.send('chat-peers-updated', peers)
            const mergedPeers = mergePeers(Array.from(networking.peers.values()), peers)
            dashboardWindow.webContents.send('peers-updated', settings.dnd ? mergedPeers.map(p => ({...p, muted: true})) : mergedPeers)
        }
        for (const win of privateChatWindows.values()) {
            if (win.isDestroyed()) continue
            win.webContents.send('chat-peers-updated', peers)
        }
    })

    app.on('chat-message', (message) => {
        if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send('chat-message', message)
    })

    app.on('private-message', (message) => {
        // Open private chat window if not open
        const otherIp = message.fromIp === networking.localIp ? message.toIp : message.fromIp
        const peer = networking.chatPeers?.get(otherIp)
        if (!privateChatWindows.has(otherIp)) {
            const peerName = peer?.name || message.from || otherIp
            const peerColor = peer?.color || ''
            const peerAvatar = peer?.avatar || null
            createPrivateChatWindow(otherIp, peerName, peerColor, peerAvatar)
        }
        // Send to private chat window
        if (privateChatWindows.has(otherIp)) {
            const win = privateChatWindows.get(otherIp)
            if (!win.isDestroyed()) {
                if (win.webContents.isLoadingMainFrame()) {
                    const queued = pendingPrivateMessages.get(otherIp) || []
                    queued.push(message)
                    pendingPrivateMessages.set(otherIp, queued)
                } else {
                    win.webContents.send('private-message', message)
                }
            }
        }
    })

    app.on('private-history', ({ targetIp, messages }) => {
        if (!targetIp || !privateChatWindows.has(targetIp)) return
        const win = privateChatWindows.get(targetIp)
        if (!win.isDestroyed()) win.webContents.send('private-history', { targetIp, messages })
    })

    app.on('private-message-status', (status) => {
        const targetIp = status?.toIp
        if (!targetIp || !privateChatWindows.has(targetIp)) return
        const win = privateChatWindows.get(targetIp)
        if (!win.isDestroyed()) win.webContents.send('private-message-status', status)
    })

    app.on('chat-typing', (data) => {
        if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send('chat-typing', data)
    })

    app.on('private-typing', (data) => {
        const otherIp = data.fromIp === networking.localIp ? data.toIp : data.fromIp
        if (privateChatWindows.has(otherIp)) {
            const win = privateChatWindows.get(otherIp)
            if (!win.isDestroyed()) win.webContents.send('private-typing', data)
        }
    })

    app.on('incoming-ping', (data) => {
        if (settings.dnd) return
        
        addToHistory({ type: 'received', peerName: data.from, peerIp: data.fromIp || 'unknown', message: data.message || '' })
        
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            const senderShape = PING_SHAPES.has(data.shape) ? data.shape : 'circle'
            setPosition(senderShape === 'border' ? 'border' : settings.position)
            overlayWindow.showInactive()
            overlayWindow.webContents.send('start-pulse', { ...data, shape: senderShape })
            overlayWindow.webContents.send('sound-changed', data.sound || settings.sound)
            setTimeout(() => {
                overlayWindow.hide()
                setPosition(settings.position)
            }, 4000)
        }
    })

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createDashboardWindow()
    })

    setInterval(() => {
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
            dashboardWindow.webContents.send('network-status', getNetworkStatusPayload())
        }
    }, 5000)
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// --- IPC Handlers ---

ipcMain.on('trigger-ping', (_event, ip, peerName, message) => {
    if (networking) {
        const soundOverride = settings.peerSounds?.[ip] || null
        networking.sendPing(ip, message || settings.customMessage || '', soundOverride, settings.pingShape)
        addToHistory({ type: 'sent', peerName: peerName || ip, peerIp: ip, message: message || settings.customMessage })
    }
})

ipcMain.on('update-setting', (_event, { key, value }) => {
    if (key === 'position') { setPosition(value); saveSettings({ position: value }) }
    if (key === 'sound') {
        saveSettings({ sound: value })
        const profile = loadProfile()
        const updatedProfile = { ...profile, pingSound: value }
        saveProfile(updatedProfile)
        if (networking) networking.setProfile({ pingSound: value })
        if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('sound-changed', value)
    }
    if (key === 'dnd') { saveSettings({ dnd: value }); if (dashboardWindow) dashboardWindow.webContents.send('settings-updated', settings) }
    if (key === 'customMessage') saveSettings({ customMessage: value })
    if (key === 'pingShape') saveSettings({ pingShape: value })
    if (key === 'peerSounds') saveSettings({ peerSounds: value || {} })
    if (key === 'quickReplies') saveSettings({ quickReplies: Array.isArray(value) ? value.slice(0, 8) : settings.quickReplies })
    if (key === 'discoveryNodeIp') {
        saveSettings({ discoveryNodeIp: (value || '').trim() })
        if (networking) networking.setDiscoveryNodeIp(settings.discoveryNodeIp || '')
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
            dashboardWindow.webContents.send('network-status', getNetworkStatusPayload())
        }
    }
    if (key === 'preferredIp') {
        saveSettings({ preferredIp: value || '' })
        if (networking) {
            const localIp = networking.setPreferredIp(settings.preferredIp || '')
            if (dashboardWindow && !dashboardWindow.isDestroyed()) {
                dashboardWindow.webContents.send('network-status', {
                    ...getNetworkStatusPayload(),
                    ip: localIp
                })
                dashboardWindow.webContents.send('peers-updated', [])
                dashboardWindow.webContents.send('chat-peers-updated', [])
            }
        }
    }
})

ipcMain.handle('get-profile', () => loadProfile())

ipcMain.on('set-profile', (_event, profile) => {
    saveProfile(profile)
    if (networking) networking.setProfile(profile)
})

ipcMain.handle('get-settings', () => settings)

ipcMain.handle('get-history', () => loadHistory())

ipcMain.on('clear-history', () => {
    pingHistory = []
    try { writeFileSync(join(app.getPath('userData'), 'history.json'), JSON.stringify([])) } catch { }
    if (dashboardWindow) dashboardWindow.webContents.send('history-updated', [])
})

ipcMain.on('complete-onboarding', (_event, profile) => {
    saveProfile(profile)
    saveSettings({ hasCompletedOnboarding: true })
    if (onboardingWindow) onboardingWindow.close()
    startApp()
})

// Chat handlers
ipcMain.on('send-chat-message', (_event, text) => { if (networking) networking.sendChatMessage(text) })
ipcMain.on('send-typing', () => { if (networking) networking.sendTypingIndicator() })
ipcMain.on('send-private-message', (_event, { toIp, text }) => { if (networking) networking.sendPrivateMessage(toIp, text) })
ipcMain.on('send-private-typing', (_event, toIp) => { if (networking) networking.sendPrivateTyping(toIp) })

// Private chat
ipcMain.on('open-private-chat', (_event, { peerIp, peerName, peerColor, peerAvatar }) => {
    createPrivateChatWindow(peerIp, peerName, peerColor, peerAvatar || null)
})

ipcMain.handle('get-peer-data', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.peerData || null
})

ipcMain.handle('get-private-chat-history', (_event, targetIp) => {
    if (!networking) return []
    return networking.getPrivateChatHistory(targetIp)
})

ipcMain.handle('get-network-interfaces', () => {
    if (!networking) return []
    return networking.getNetworkInterfaces()
})
