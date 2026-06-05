const peersContainer = document.getElementById('peers-container')
const historyContainer = document.getElementById('history-container')
const chatMessagesContainer = document.getElementById('chat-messages')
const chatInput = document.getElementById('chat-input')
const sendChatBtn = document.getElementById('send-chat')
const typingIndicator = document.getElementById('typing-indicator')
const chatStatus = document.getElementById('chat-status')
const soundPicker = document.getElementById('sound-picker')
const statusSelect = document.getElementById('status-select')
const pingShapeSelect = document.getElementById('ping-shape')
const preferredIpSelect = document.getElementById('preferred-ip')
const discoveryNodeIpInput = document.getElementById('discovery-node-ip')
const positionRadios = document.getElementsByName('position')
const dndToggle = document.getElementById('dnd-toggle')
const customMessageInput = document.getElementById('custom-message')
const profileNameInput = document.getElementById('profile-name')
const profileAvatar = document.getElementById('profile-avatar')
const uploadAvatarBtn = document.getElementById('upload-avatar-btn')
const avatarUploadInput = document.getElementById('avatar-upload')
const saveProfileBtn = document.getElementById('save-profile')
const quickRepliesContainer = document.getElementById('quick-replies')
const quickReplyInput = document.getElementById('quick-reply-input')
const addQuickReplyBtn = document.getElementById('add-quick-reply')
const networkInfo = document.getElementById('network-info')
const networkDebug = document.getElementById('network-debug')
const clearHistoryBtn = document.getElementById('clear-history')
const tabs = document.querySelectorAll('.tab')
const tabContents = document.querySelectorAll('.tab-content')

const DEFAULT_QUICK_REPLIES = ['On my way!', 'Be there in 5', 'Thanks!', 'Got it', 'One moment']
const SOUND_OPTIONS = ['chime', 'bubble', 'tap', 'bell', 'drop', 'off']
const SOUND_LABELS = {
    chime: 'Chime',
    bubble: 'Bubble',
    tap: 'Tap',
    bell: 'Bell',
    drop: 'Drop',
    off: 'Off'
}

let peers = []
let chatPeers = []
let history = []
let myProfile = null
let currentSettings = {
    position: 'top-right',
    sound: 'chime',
    dnd: false,
    customMessage: '',
    pingShape: 'circle',
    discoveryNodeIp: '',
    peerSounds: {},
    quickReplies: DEFAULT_QUICK_REPLIES
}
let typingTimeout = null
let msgTimeout = null
let discoveryNodeTimeout = null
let networkInterfaces = []
const renderedGroupMessageIds = new Map()
const renderedGroupMessageSigs = new Map()

async function init() {
    try {
        currentSettings = { ...currentSettings, ...(await window.api.getSettings()) }
        applySettings(currentSettings)
    } catch (e) {
        console.warn('Could not load settings:', e)
    }

    myProfile = await window.api.getProfile()
    if (!myProfile) myProfile = { displayName: '', avatarColor: '', pingSound: 'chime', status: 'online', avatar: null }
    profileNameInput.value = myProfile.displayName || ''
    statusSelect.value = myProfile.status || 'online'
    renderProfileAvatar()

    try {
        history = await window.api.getHistory()
        updateHistory()
    } catch (e) {
        console.warn('Could not load history:', e)
    }

    try {
        const savedSound = localStorage.getItem('ping-sound')
        if (savedSound && !currentSettings.sound) soundPicker.value = savedSound
    } catch {}

    try {
        networkInterfaces = await window.api.getNetworkInterfaces()
        renderPreferredIpOptions()
    } catch (e) {
        console.warn('Could not load network interfaces:', e)
    }
}

function escapeHtml(text = '') {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
}

function escapeAttr(text = '') {
    return escapeHtml(text).replace(/"/g, '&quot;')
}

function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatAgo(ts) {
    if (!ts) return 'never'
    const deltaSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
    if (deltaSec < 60) return `${deltaSec}s ago`
    const mins = Math.floor(deltaSec / 60)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    return `${hrs}h ago`
}

function applySettings(settings) {
    currentSettings = {
        ...currentSettings,
        ...settings,
        peerSounds: settings.peerSounds || {},
        quickReplies: Array.isArray(settings.quickReplies) && settings.quickReplies.length ? settings.quickReplies : DEFAULT_QUICK_REPLIES
    }
    for (const radio of positionRadios) radio.checked = radio.value === currentSettings.position
    soundPicker.value = currentSettings.sound || 'chime'
    pingShapeSelect.value = currentSettings.pingShape || 'circle'
    dndToggle.checked = currentSettings.dnd || false
    customMessageInput.value = currentSettings.customMessage || ''
    discoveryNodeIpInput.value = currentSettings.discoveryNodeIp || ''
    updateDndUI(currentSettings.dnd)
    renderQuickReplies()
    renderPreferredIpOptions()
    updatePeers()
}

function renderPreferredIpOptions() {
    if (!preferredIpSelect) return
    const selected = currentSettings.preferredIp || ''
    const options = [
        '<option value="">Auto (Best LAN IP)</option>',
        ...networkInterfaces.map((item) => {
            const label = `${item.name} - ${item.address}`
            return `<option value="${escapeAttr(item.address)}">${escapeHtml(label)}</option>`
        })
    ]
    preferredIpSelect.innerHTML = options.join('')
    preferredIpSelect.value = selected
}

function updateDndUI(isDnd) {
    peersContainer.querySelectorAll('.peer-card').forEach(card => card.classList.toggle('muted', isDnd))
}

function findChatPeer(ip) {
    return chatPeers.find((peer) => peer.ip === ip) || null
}

function getPeerSound(ip) {
    return currentSettings.peerSounds?.[ip] || currentSettings.sound || 'chime'
}

function renderProfileAvatar() {
    const nameInitial = myProfile?.displayName?.charAt(0).toUpperCase() || '?'
    profileAvatar.textContent = nameInitial
    if (myProfile?.avatar) {
        profileAvatar.style.backgroundImage = `url("${myProfile.avatar}")`
        profileAvatar.style.color = 'transparent'
    } else {
        profileAvatar.style.backgroundImage = 'none'
        profileAvatar.style.color = '#ffffff'
        if (myProfile?.avatarColor) profileAvatar.style.background = myProfile.avatarColor
    }
}

function updatePeers() {
    if (peers.length === 0) {
        peersContainer.innerHTML = '<p class="empty-state">Looking for peers...</p>'
        return
    }

    peersContainer.innerHTML = peers.map((peer) => {
        const chatPeer = findChatPeer(peer.ip)
        const status = chatPeer?.status || 'offline'
        const avatar = chatPeer?.avatar || ''
        const peerSound = getPeerSound(peer.ip)
        const options = SOUND_OPTIONS.map((value) => {
            const selected = peerSound === value ? 'selected' : ''
            return `<option value="${value}" ${selected}>${SOUND_LABELS[value]}</option>`
        }).join('')
        const avatarStyle = avatar
            ? `background-image:url("${escapeAttr(avatar)}"); background-size:cover; background-position:center; color:transparent;`
            : `background: ${peer.color || 'var(--primary-gradient)'}`
        return `
            <div class="peer-card ${peer.muted ? 'muted' : ''}">
                <div class="peer-info">
                    <div class="avatar" style="${avatarStyle}">${escapeHtml(peer.name.charAt(0).toUpperCase())}</div>
                    <div>
                        <div class="peer-details">
                            <span class="peer-name">${escapeHtml(peer.name)}</span>
                            ${peer.muted ? '<span class="muted-badge">🔇</span>' : ''}
                        </div>
                        <span class="peer-status">${escapeHtml(status)}</span>
                    </div>
                </div>
                <div class="peer-actions">
                    <select class="peer-sound" data-ip="${peer.ip}">${options}</select>
                    <button class="ping-btn" data-ip="${peer.ip}" data-name="${escapeAttr(peer.name)}">Ping</button>
                    <button class="chat-btn" data-ip="${peer.ip}" data-name="${escapeAttr(peer.name)}" data-color="${escapeAttr(peer.color || '')}" data-avatar="${escapeAttr(avatar)}">💬</button>
                </div>
            </div>
        `
    }).join('')

    peersContainer.querySelectorAll('.peer-sound').forEach((select) => {
        select.addEventListener('change', () => {
            const nextPeerSounds = { ...(currentSettings.peerSounds || {}) }
            nextPeerSounds[select.dataset.ip] = select.value
            currentSettings.peerSounds = nextPeerSounds
            window.api.updateSetting('peerSounds', nextPeerSounds)
        })
    })

    peersContainer.querySelectorAll('.ping-btn').forEach((btn) => {
        btn.disabled = currentSettings.dnd
        btn.addEventListener('click', () => {
            const msg = customMessageInput.value.trim()
            window.api.sendPing(btn.dataset.ip, btn.dataset.name, msg)
            btn.textContent = 'Sent!'
            btn.disabled = true
            setTimeout(() => {
                btn.textContent = 'Ping'
                btn.disabled = currentSettings.dnd
            }, 1500)
        })
    })

    peersContainer.querySelectorAll('.chat-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            window.api.openPrivateChat(btn.dataset.ip, btn.dataset.name, btn.dataset.color, btn.dataset.avatar || null)
        })
    })
}

function appendChatMessage(msg) {
    const idKey = msg?.id ? `id:${msg.id}` : null
    const sigKey = `sig:${msg?.fromIp || msg?.from || 'unknown'}:${msg?.text || ''}:${Math.floor((msg?.timestamp || Date.now()) / 2000)}`
    const now = Date.now()
    for (const [key, ts] of renderedGroupMessageIds.entries()) {
        if (now - ts > 15000) renderedGroupMessageIds.delete(key)
    }
    for (const [key, ts] of renderedGroupMessageSigs.entries()) {
        if (now - ts > 15000) renderedGroupMessageSigs.delete(key)
    }
    if ((idKey && renderedGroupMessageIds.has(idKey)) || renderedGroupMessageSigs.has(sigKey)) return
    if (idKey) renderedGroupMessageIds.set(idKey, now)
    renderedGroupMessageSigs.set(sigKey, now)

    const isMine = msg.from === myProfile?.displayName || msg.fromIp === '127.0.0.1'
    const msgEl = document.createElement('div')
    msgEl.className = `chat-message ${isMine ? 'mine' : 'theirs'}`
    msgEl.innerHTML = `
        ${!isMine ? `<span class="chat-sender">${escapeHtml(msg.from)}</span>` : ''}
        <span class="chat-text">${escapeHtml(msg.text)}</span>
        <span class="chat-time">${formatTime(msg.timestamp)}</span>
    `
    chatMessagesContainer.appendChild(msgEl)
    chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight
}

function sendMessage(textOverride = null) {
    const text = (textOverride ?? chatInput.value).trim()
    if (!text) return
    window.api.sendChatMessage(text)
    if (textOverride === null) chatInput.value = ''
    typingIndicator.textContent = ''
}

function renderQuickReplies() {
    quickRepliesContainer.innerHTML = (currentSettings.quickReplies || DEFAULT_QUICK_REPLIES).map((reply) => (
        `<button class="quick-reply-btn" data-text="${escapeAttr(reply)}">${escapeHtml(reply)}</button>`
    )).join('')

    quickRepliesContainer.querySelectorAll('.quick-reply-btn').forEach((btn) => {
        btn.addEventListener('click', () => sendMessage(btn.dataset.text))
        btn.addEventListener('contextmenu', (event) => {
            event.preventDefault()
            const nextReplies = (currentSettings.quickReplies || []).filter((item) => item !== btn.dataset.text)
            currentSettings.quickReplies = nextReplies.length ? nextReplies : DEFAULT_QUICK_REPLIES
            window.api.updateSetting('quickReplies', currentSettings.quickReplies)
            renderQuickReplies()
        })
    })
}

async function persistProfile(showSaved = false) {
    await window.api.setProfile(myProfile)
    if (showSaved) {
        saveProfileBtn.textContent = 'Saved!'
        setTimeout(() => {
            saveProfileBtn.textContent = 'Save'
        }, 1500)
    }
}

function fileToAvatarData(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
            const image = new Image()
            image.onload = () => {
                const size = 160
                const canvas = document.createElement('canvas')
                canvas.width = size
                canvas.height = size
                const context = canvas.getContext('2d')
                context.clearRect(0, 0, size, size)
                context.drawImage(image, 0, 0, size, size)
                resolve(canvas.toDataURL('image/jpeg', 0.82))
            }
            image.onerror = reject
            image.src = reader.result
        }
        reader.onerror = reject
        reader.readAsDataURL(file)
    })
}

function updateHistory() {
    if (history.length === 0) {
        historyContainer.innerHTML = '<p class="empty-state">No recent pings...</p>'
        return
    }
    historyContainer.innerHTML = history.map((entry) => `
        <div class="history-card ${entry.type}">
            <div class="history-icon">${entry.type === 'sent' ? '📤' : '📥'}</div>
            <div class="history-details">
                <span class="history-action">${entry.type === 'sent' ? 'Pinged' : 'From'}</span>
                <span class="history-name">${escapeHtml(entry.peerName)}</span>
                ${entry.message ? `<span class="history-message">"${escapeHtml(entry.message)}"</span>` : ''}
            </div>
            <span class="history-time">${formatTime(entry.timestamp)}</span>
        </div>
    `).join('')
}

tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab
        tabs.forEach((item) => item.classList.remove('active'))
        tab.classList.add('active')
        tabContents.forEach((content) => content.classList.toggle('active', content.id === `${tabName}-tab`))
    })
})

saveProfileBtn.addEventListener('click', async () => {
    const name = profileNameInput.value.trim()
    if (!name) return
    myProfile.displayName = name
    myProfile.status = statusSelect.value
    renderProfileAvatar()
    await persistProfile(true)
})

profileNameInput.addEventListener('input', () => {
    myProfile.displayName = profileNameInput.value.trim()
    if (!myProfile.avatar) renderProfileAvatar()
})

statusSelect.addEventListener('change', async () => {
    myProfile.status = statusSelect.value
    await persistProfile(false)
})

uploadAvatarBtn.addEventListener('click', () => avatarUploadInput.click())
avatarUploadInput.addEventListener('change', async () => {
    const file = avatarUploadInput.files?.[0]
    if (!file) return
    try {
        myProfile.avatar = await fileToAvatarData(file)
        renderProfileAvatar()
        await persistProfile(false)
    } catch (error) {
        console.warn('Avatar upload failed:', error)
    } finally {
        avatarUploadInput.value = ''
    }
})

sendChatBtn.addEventListener('click', () => sendMessage())
chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sendMessage()
    else window.api.sendTyping()
})
chatInput.addEventListener('input', () => window.api.sendTyping())

addQuickReplyBtn.addEventListener('click', () => {
    const text = quickReplyInput.value.trim()
    if (!text) return
    const existing = currentSettings.quickReplies || []
    if (existing.includes(text)) {
        quickReplyInput.value = ''
        return
    }
    const nextReplies = [...existing, text].slice(0, 8)
    currentSettings.quickReplies = nextReplies
    window.api.updateSetting('quickReplies', nextReplies)
    quickReplyInput.value = ''
    renderQuickReplies()
})

quickReplyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addQuickReplyBtn.click()
})

clearHistoryBtn.addEventListener('click', () => {
    window.api.clearHistory()
    history = []
    updateHistory()
})

dndToggle.addEventListener('change', () => {
    const isDnd = dndToggle.checked
    currentSettings.dnd = isDnd
    window.api.updateSetting('dnd', isDnd)
    updateDndUI(isDnd)
    updatePeers()
})

pingShapeSelect.addEventListener('change', () => {
    currentSettings.pingShape = pingShapeSelect.value
    window.api.updateSetting('pingShape', currentSettings.pingShape)
})

soundPicker.addEventListener('change', () => {
    currentSettings.sound = soundPicker.value
    window.api.updateSetting('sound', currentSettings.sound)
    try {
        localStorage.setItem('ping-sound', currentSettings.sound)
    } catch {}
})

positionRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
        if (!radio.checked) return
        currentSettings.position = radio.value
        window.api.updateSetting('position', currentSettings.position)
    })
})

preferredIpSelect.addEventListener('change', async () => {
    const selectedIp = preferredIpSelect.value || ''
    currentSettings.preferredIp = selectedIp
    window.api.updateSetting('preferredIp', selectedIp)
    try {
        networkInterfaces = await window.api.getNetworkInterfaces()
        renderPreferredIpOptions()
    } catch {}
})

customMessageInput.addEventListener('input', () => {
    clearTimeout(msgTimeout)
    msgTimeout = setTimeout(() => {
        currentSettings.customMessage = customMessageInput.value.trim()
        window.api.updateSetting('customMessage', currentSettings.customMessage)
    }, 500)
})

discoveryNodeIpInput.addEventListener('input', () => {
    clearTimeout(discoveryNodeTimeout)
    discoveryNodeTimeout = setTimeout(() => {
        const value = discoveryNodeIpInput.value.trim()
        currentSettings.discoveryNodeIp = value
        window.api.updateSetting('discoveryNodeIp', value)
    }, 500)
})

window.api.onPeersUpdated((updatedPeers) => {
    peers = updatedPeers
    updatePeers()
})

window.api.onChatMessage((message) => appendChatMessage(message))
window.api.onChatTyping((data) => {
    if (data.from === myProfile?.displayName) return
    typingIndicator.textContent = `${data.from} is typing...`
    clearTimeout(typingTimeout)
    typingTimeout = setTimeout(() => {
        typingIndicator.textContent = ''
    }, 2000)
})

window.api.onChatPeersUpdated((updatedChatPeers) => {
    chatPeers = updatedChatPeers
    chatStatus.textContent = updatedChatPeers.length > 0 ? `${updatedChatPeers.length} online` : 'Connecting...'
    updatePeers()
})

window.api.onHistoryUpdated((updatedHistory) => {
    history = updatedHistory
    updateHistory()
})

window.api.onSettingsUpdated((settings) => applySettings(settings))
window.api.onNetworkStatus((status) => {
    currentSettings.preferredIp = status.preferredIp || currentSettings.preferredIp || ''
    renderPreferredIpOptions()
    networkInfo.textContent = `Active as ${status.hostname} (${status.ip})`
    if (networkDebug) {
        const d = status.diagnostics || {}
        networkDebug.textContent = [
            `nodeIp=${status.discoveryNodeIp || '(none)'}`,
            `nodeConnected=${d.discoveryNodeConnected ? 'yes' : 'no'} | peerListSync=${formatAgo(d.lastPeerListSyncAt)} | peerListCount=${d.lastPeerListCount || 0}`,
            `peers=${d.peersCount || 0} chatPeers=${d.chatPeersCount || 0}`,
            `mdns: rxResp=${d.mdnsResponsesReceived || 0} rxQry=${d.mdnsQueriesReceived || 0} txQry=${d.mdnsQueriesSent || 0} txAnn=${d.mdnsAnnouncementsSent || 0} resets=${d.mdnsResets || 0}`,
            `mdnsLast: resp=${formatAgo(d.lastMdnsResponseAt)} query=${formatAgo(d.lastMdnsQueryAt)} sentQuery=${formatAgo(d.lastQuerySentAt)} announce=${formatAgo(d.lastAnnounceAt)}`,
            `subnetProbe: last=${formatAgo(d.lastSubnetProbeAt)} hits=${d.lastSubnetProbeHits || 0} lastHitIp=${d.lastSubnetHitIp || '(none)'}`,
            `nodeConnect: attempt=${formatAgo(d.lastNodeConnectAttemptAt)} success=${formatAgo(d.lastNodeConnectSuccessAt)}`,
            `connect: lastAttemptIp=${d.lastConnectAttemptIp || '(none)'} lastSuccessIp=${d.lastConnectSuccessIp || '(none)'} lastError=${d.lastConnectError || '(none)'}`,
            `discovery: lastPeerIp=${d.lastDiscoveryPeerIp || '(none)'}`
        ].join('\\n')
    }
})

init()
