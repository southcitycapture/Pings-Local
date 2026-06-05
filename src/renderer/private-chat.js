let peerData = null
let myProfile = null
const renderedMessageIds = new Set()
const pendingStatuses = new Map()
const statusElements = new Map()

const messagesContainer = document.getElementById('messages')
const messageInput = document.getElementById('message-input')
const sendBtn = document.getElementById('send-btn')
const typingIndicator = document.getElementById('typing-indicator')
const peerAvatar = document.getElementById('peer-avatar')
const peerName = document.getElementById('peer-name')
const peerStatus = document.getElementById('peer-status')

let typingTimeout = null

async function init() {
    peerData = await window.api.getPeerData()
    myProfile = await window.api.getProfile()
    
    if (peerData) {
        peerAvatar.textContent = peerData.name.charAt(0).toUpperCase()
        peerAvatar.style.background = peerData.color || 'var(--primary-gradient)'
        if (peerData.avatar) {
            peerAvatar.style.backgroundImage = `url("${peerData.avatar}")`
            peerAvatar.style.backgroundSize = 'cover'
            peerAvatar.style.backgroundPosition = 'center'
            peerAvatar.style.color = 'transparent'
        }
        peerName.textContent = peerData.name
        document.title = `Chat - ${peerData.name}`
    }

    await loadHistory()
    updatePeerStatus()
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function escapeHtml(text) {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
}

function appendMessage(msg) {
    if (!isMessageForThisChat(msg)) return
    if (msg?.id && renderedMessageIds.has(msg.id)) return
    if (msg?.id) renderedMessageIds.add(msg.id)
    const isMine = msg.fromIp === peerData?.localIp || msg.from === myProfile?.displayName
    
    // Remove empty state
    const emptyState = messagesContainer.querySelector('.empty-state')
    if (emptyState) emptyState.remove()
    
    const msgEl = document.createElement('div')
    msgEl.className = `message ${isMine ? 'mine' : 'theirs'}`
    msgEl.innerHTML = `
        <span class="message-text">${escapeHtml(msg.text)}</span>
        <span class="message-time">${formatTime(msg.timestamp)}</span>
        ${isMine ? '<span class="message-delivery" data-status="sending">sending</span>' : ''}
    `
    
    messagesContainer.appendChild(msgEl)
    if (isMine && msg?.id) {
        const statusEl = msgEl.querySelector('.message-delivery')
        statusElements.set(msg.id, statusEl)
        applyMessageStatus(msg.id, pendingStatuses.get(msg.id) || { status: 'sending' })
    }
    messagesContainer.scrollTop = messagesContainer.scrollHeight
}

function isMessageForThisChat(msg) {
    if (!peerData?.ip) return false
    const localIp = peerData.localIp
    const participants = [msg.fromIp, msg.toIp]
    if (!participants.includes(peerData.ip)) return false
    if (!localIp) return true
    return participants.includes(localIp)
}

function sendMessage() {
    const text = messageInput.value.trim()
    if (!text || !peerData) return
    
    window.api.sendPrivateMessage(peerData.ip, text)
    messageInput.value = ''
    typingIndicator.textContent = ''
}

async function loadHistory() {
    if (!peerData?.ip) return
    const history = await window.api.getPrivateChatHistory(peerData.ip)
    if (!Array.isArray(history) || history.length === 0) return
    history.sort((a, b) => a.timestamp - b.timestamp).forEach(appendMessage)
}

function updatePeerStatus(status) {
    if (!peerStatus) return
    const peerOnline = status === 'online' || status === 'away' || status === 'busy'
    peerStatus.textContent = status || 'offline'
    peerStatus.style.color = peerOnline ? 'var(--success)' : 'var(--text-muted)'
}

function getStatusLabel(payload) {
    const status = payload?.status || 'sending'
    if (status === 'sent') return 'sent'
    if (status === 'retrying') return `retrying (${payload?.attempt || 1})`
    if (status === 'failed') return 'failed'
    return 'sending'
}

function applyMessageStatus(messageId, payload) {
    if (!messageId || !payload) return
    pendingStatuses.set(messageId, payload)
    const statusEl = statusElements.get(messageId)
    if (!statusEl) return
    const label = getStatusLabel(payload)
    statusEl.textContent = label
    statusEl.dataset.status = payload.status || 'sending'
    statusEl.title = payload.error || ''
}

sendBtn.addEventListener('click', sendMessage)

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage()
})

messageInput.addEventListener('input', () => {
    if (peerData) {
        window.api.sendPrivateTyping(peerData.ip)
    }
})

window.api.onPrivateMessage((msg) => {
    appendMessage(msg)
})

window.api.onPrivateTyping((data) => {
    if (data.fromIp === peerData?.ip) {
        typingIndicator.textContent = `${peerData.name} is typing...`
        clearTimeout(typingTimeout)
        typingTimeout = setTimeout(() => {
            typingIndicator.textContent = ''
        }, 2000)
    }
})

window.api.onPrivateHistory((data) => {
    if (!data || data.targetIp !== peerData?.ip) return
    ;(data.messages || []).sort((a, b) => a.timestamp - b.timestamp).forEach(appendMessage)
})

window.api.onChatPeersUpdated((peers) => {
    const peer = peers.find((item) => item.ip === peerData?.ip)
    updatePeerStatus(peer ? peer.status : 'offline')
})

window.api.onPrivateMessageStatus((payload) => {
    if (!payload || payload.toIp !== peerData?.ip) return
    applyMessageStatus(payload.id, payload)
})

init()
