import mdns from 'multicast-dns'
import { Server } from 'socket.io'
import { io } from 'socket.io-client'
import os from 'os'
import http from 'http'
import net from 'net'

const MDNS_SERVICE_NAME = '_pings._tcp.local'
const CHAT_PORT = 43211
const PING_PORT = 43210

function normalizeIp(ip) {
  if (!ip || typeof ip !== 'string') return 'unknown'
  return ip.replace('::ffff:', '')
}

function isPrivateIpv4(ip) {
  if (!ip || typeof ip !== 'string') return false
  if (ip.startsWith('10.')) return true
  if (ip.startsWith('192.168.')) return true
  const parts = ip.split('.').map((n) => Number(n))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
}

function isCarrierGradeNatIpv4(ip) {
  if (!ip || typeof ip !== 'string') return false
  const parts = ip.split('.').map((n) => Number(n))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

function interfacePenalty(name = '') {
  const lowered = name.toLowerCase()
  if (lowered.includes('tailscale')) return 100
  if (lowered.includes('utun')) return 90
  if (lowered.includes('wg') || lowered.includes('wireguard')) return 80
  if (lowered.includes('tun')) return 70
  return 0
}

function getColorFromName(name) {
  const colors = [
    'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
    'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
    'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
    'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
    'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
    'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)',
    'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)'
  ]
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return colors[Math.abs(hash) % colors.length]
}

export class Networking {
  constructor(app) {
    this.app = app
    this.mdns = null
    this.peers = new Map()
    this.chatPeers = new Map()
    this.chatSockets = new Map()
    this.privateChats = new Map()
    this.privateMessageRetries = new Map()
    this.seenChatMessages = new Map()
    this.chatMessages = []

    this.httpServer = null
    this.socketServer = null
    this.chatServer = null
    this.chatHttpServer = null

    this.hostname = os.hostname().replace('.local', '')
    this.displayName = this.hostname
    this.avatarColor = ''
    this.avatar = null
    this.pingSound = 'chime'
    this.status = 'online'

    this.serviceName = MDNS_SERVICE_NAME
    this.instanceName = `${this.hostname}._pings._tcp.local`
    this.localIp = null
    this.preferredIp = ''
    this.discoveryNodeIp = ''
    this.started = false
    this.lastSubnetProbeAt = 0
    this.isSubnetProbeRunning = false

    this.diagnostics = {
      mdnsResets: 0,
      mdnsQueriesSent: 0,
      mdnsAnnouncementsSent: 0,
      mdnsResponsesReceived: 0,
      mdnsQueriesReceived: 0,
      lastMdnsResponseAt: 0,
      lastMdnsQueryAt: 0,
      lastAnnounceAt: 0,
      lastQuerySentAt: 0,
      lastSubnetProbeAt: 0,
      lastSubnetProbeHits: 0,
      lastNodeConnectAttemptAt: 0,
      lastNodeConnectSuccessAt: 0,
      lastPeerListSyncAt: 0,
      lastPeerListCount: 0,
      lastDiscoveryPeerIp: '',
      lastConnectAttemptIp: '',
      lastConnectSuccessIp: '',
      lastConnectError: '',
      lastSubnetHitIp: ''
    }
  }

  start() {
    this.localIp = this.getLocalIp()
    this.resetMdns()
    this.startPingServer()
    this.startChatServer()
    this.announce()
    this.query()
    this.started = true

    setInterval(() => {
      // Add jitter to prevent storming
      setTimeout(() => {
        this.announce()
        this.query()
        this.cleanupPeers()
        this.maybeProbeSubnet()
        this.bootstrapFromDiscoveryNode()
      }, Math.random() * 2000)
    }, 10000)
  }

  setPreferredIp(ip) {
    this.preferredIp = ip || ''
    const nextLocalIp = this.getLocalIp()
    const changed = nextLocalIp !== this.localIp
    this.localIp = nextLocalIp
    if (!this.started) return this.localIp

    if (changed) {
      for (const [peerIp, socket] of this.chatSockets.entries()) {
        try { socket.disconnect() } catch {}
        this.chatSockets.delete(peerIp)
      }
      this.chatPeers.clear()
      this.peers.clear()
      this.broadcastPeers()
      this.broadcastChatPeers()
    }

    this.resetMdns()
    this.announce()
    this.bootstrapFromDiscoveryNode()
    return this.localIp
  }

  setDiscoveryNodeIp(ip) {
    this.discoveryNodeIp = (ip || '').trim()
    if (this.started) this.bootstrapFromDiscoveryNode()
  }

  getDiagnostics() {
    const nodeSocket = this.discoveryNodeIp ? this.chatSockets.get(this.discoveryNodeIp) : null
    return {
      localIp: this.localIp,
      preferredIp: this.preferredIp || '',
      discoveryNodeIp: this.discoveryNodeIp || '',
      discoveryNodeConnected: Boolean(nodeSocket?.connected),
      peersCount: this.peers.size,
      chatPeersCount: this.chatPeers.size,
      ...this.diagnostics
    }
  }

  resetMdns() {
    if (this.mdns) {
      try { this.mdns.destroy() } catch {}
    }
    this.mdns = mdns({ loopback: true })
    this.diagnostics.mdnsResets += 1
    this.startDiscovery()
  }

  getNetworkInterfaces() {
    const interfaces = os.networkInterfaces()
    const candidates = []
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family !== 'IPv4' || iface.internal) continue
        let score = 100
        if (isPrivateIpv4(iface.address)) score -= 60
        if (isCarrierGradeNatIpv4(iface.address)) score += 20
        score += interfacePenalty(name)
        candidates.push({
          name,
          address: iface.address,
          preferred: this.preferredIp === iface.address,
          score
        })
      }
    }
    candidates.sort((a, b) => a.score - b.score)
    return candidates
  }

  setDisplayName(name) {
    this.displayName = name || this.hostname
    this.instanceName = `${this.hostname}._pings._tcp.local`
    if (this.started) this.announce()
  }

  setProfile(data) {
    if (data.displayName) this.displayName = data.displayName
    if (data.avatarColor) this.avatarColor = data.avatarColor
    if (data.avatar !== undefined) this.avatar = data.avatar
    if (data.pingSound) this.pingSound = data.pingSound
    if (data.status) this.status = data.status

    for (const socket of this.chatSockets.values()) {
      if (!socket.connected) continue
      socket.emit('register', {
        name: this.displayName,
        color: this.avatarColor || getColorFromName(this.displayName),
        pingSound: this.pingSound,
        status: this.status,
        avatar: this.avatar,
        ip: this.localIp
      })
    }

    if (this.started) this.announce()
  }

  startPingServer() {
    this.httpServer = http.createServer()
    this.socketServer = new Server(this.httpServer, { cors: { origin: '*' } })

    this.socketServer.on('connection', (socket) => {
      socket.on('ping-user', (data) => {
        const fromIp = normalizeIp(socket.handshake.address)
        this.app.emit('incoming-ping', { ...data, fromIp })
      })
    })

    this.httpServer.listen(PING_PORT, '0.0.0.0', () => {
      console.log(`[Pings] Ping server on port ${PING_PORT}`)
    })

    this.httpServer.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        console.error('[Pings] Ping port in use, retrying...')
        setTimeout(() => {
          this.httpServer.close()
          this.httpServer.listen(PING_PORT, '0.0.0.0')
        }, 2000)
      }
    })
  }

  startChatServer() {
    this.chatHttpServer = http.createServer()
    this.chatServer = new Server(this.chatHttpServer, { cors: { origin: '*' } })

    this.chatServer.on('connection', (socket) => {
      const ip = normalizeIp(socket.handshake.address)
      console.log(`[Pings] Chat peer: ${ip}`)

      socket.on('register', (data) => {
        const declaredIp = data.ip || ip
        const peerData = {
          ip: declaredIp,
          name: data.name || declaredIp,
          color: data.color || getColorFromName(data.name || declaredIp),
          pingSound: data.pingSound || 'chime',
          status: data.status || 'online',
          avatar: data.avatar || null,
          lastSeen: Date.now()
        }
        socket.data.peerIp = declaredIp
        this.touchChatPeer(declaredIp, peerData)
        this.touchPeer(declaredIp, peerData.name, peerData.color)

        if (this.chatMessages.length > 0) {
          socket.emit('history', this.chatMessages.slice(-50))
        }
      })

      socket.on('peer-list-request', (_data, ack) => {
        if (typeof ack !== 'function') return
        const requesterIp = socket.data.peerIp || ip
        const merged = new Map()
        for (const peer of this.peers.values()) {
          if (peer?.ip) merged.set(peer.ip, { ...peer })
        }
        for (const peer of this.chatPeers.values()) {
          if (!peer?.ip) continue
          const existing = merged.get(peer.ip) || {}
          merged.set(peer.ip, {
            ...existing,
            ...peer,
            ip: peer.ip,
            name: peer.name || existing.name || peer.ip,
            color: peer.color || existing.color,
            lastSeen: Math.max(existing.lastSeen || 0, peer.lastSeen || Date.now())
          })
        }
        const peers = Array.from(merged.values()).filter((peer) => peer.ip && peer.ip !== requesterIp)
        ack({ peers, timestamp: Date.now() })
      })

      socket.on('message', (data) => {
        const senderIp = socket.data.peerIp || ip
        const message = {
          id: data.id || (Date.now().toString(36) + Math.random().toString(36).substr(2)),
          from: data.from,
          fromIp: senderIp,
          text: data.text,
          timestamp: data.timestamp || Date.now(),
          type: data.type || 'group'
        }
        this.touchPeer(senderIp, data.from || senderIp)
        if (this.isDuplicateChatMessage(message)) return

        this.chatMessages.push(message)
        if (this.chatMessages.length > 200) this.chatMessages = this.chatMessages.slice(-200)

        this.chatServer.emit('message', message)
        this.app.emit('chat-message', message)
      })

      socket.on('private-message', (data, ack) => {
        const senderIp = socket.data.peerIp || data.fromIp || ip
        const message = {
          id: data.id || (Date.now().toString(36) + Math.random().toString(36).substr(2)),
          from: data.from,
          fromIp: senderIp,
          toIp: data.toIp,
          text: data.text,
          timestamp: data.timestamp || Date.now(),
          type: 'private'
        }
        this.touchPeer(senderIp, data.from || senderIp)

        const chatKey = [senderIp, data.toIp].sort().join('-')
        if (!this.privateChats.has(chatKey)) this.privateChats.set(chatKey, [])
        const bucket = this.privateChats.get(chatKey)
        if (!bucket.some((item) => item.id === message.id)) bucket.push(message)

        this.chatServer.emit('private-message', message)
        this.app.emit('private-message', message)
        if (typeof ack === 'function') ack({ ok: true, messageId: message.id, receivedAt: Date.now() })
      })

      socket.on('get-private-chat', (data) => {
        const senderIp = socket.data.peerIp || ip
        const chatKey = [senderIp, data.targetIp].sort().join('-')
        const messages = this.privateChats.get(chatKey) || []
        socket.emit('private-history', { targetIp: data.targetIp, messages })
      })

      socket.on('typing', (data) => {
        const senderIp = socket.data.peerIp || ip
        socket.broadcast.emit('typing', { from: data.from, fromIp: senderIp })
      })

      socket.on('private-typing', (data) => {
        const senderIp = socket.data.peerIp || data.fromIp || ip
        this.touchChatPeer(senderIp, { name: data.from, status: 'online' })
        this.touchPeer(senderIp, data.from || senderIp)
        socket.broadcast.emit('private-typing', { from: data.from, fromIp: senderIp, toIp: data.toIp })
      })

      socket.on('status-update', (data) => {
        const senderIp = socket.data.peerIp || ip
        const peer = this.chatPeers.get(senderIp)
        if (peer) {
          peer.status = data.status
          this.broadcastChatPeers()
        }
      })

      socket.on('disconnect', () => {
        const peerIp = socket.data.peerIp || ip
        this.chatPeers.delete(peerIp)
        this.broadcastChatPeers()
      })
    })

    this.chatHttpServer.listen(CHAT_PORT, '0.0.0.0', () => {
      console.log(`[Pings] Chat server on port ${CHAT_PORT}`)
    })

    this.chatHttpServer.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        console.error('[Pings] Chat port in use, retrying...')
        setTimeout(() => {
          this.chatHttpServer.close()
          this.chatHttpServer.listen(CHAT_PORT, '0.0.0.0')
        }, 2000)
      }
    })
  }

  connectToChatPeer(ip) {
    if (!ip || ip === this.localIp) return null
    const existing = this.chatSockets.get(ip)
    if (existing) return existing
    this.diagnostics.lastConnectAttemptIp = ip

    const socket = io(`http://${ip}:${CHAT_PORT}`, {
      timeout: 5000,
      reconnection: true,
      reconnectionAttempts: 3,
      reconnectionDelay: 1000
    })
    this.chatSockets.set(ip, socket)

    socket.on('connect', () => {
      if (ip === this.discoveryNodeIp) this.diagnostics.lastNodeConnectSuccessAt = Date.now()
      this.diagnostics.lastConnectSuccessIp = ip
      console.log(`[Pings] Connected to chat: ${ip}`)
      this.touchChatPeer(ip, { status: 'online' })
      this.touchPeer(ip)
      socket.emit('register', {
        name: this.displayName,
        color: this.avatarColor || getColorFromName(this.displayName),
        pingSound: this.pingSound,
        status: this.status,
        avatar: this.avatar,
        ip: this.localIp
      })
    })

    socket.on('disconnect', () => {
      const peer = this.chatPeers.get(ip)
      if (peer) {
        peer.status = 'offline'
        peer.lastSeen = Date.now()
        this.chatPeers.set(ip, peer)
        this.broadcastChatPeers()
      }
      if (this.chatSockets.get(ip) === socket) this.chatSockets.delete(ip)
    })

    socket.on('connect_error', () => {
      this.diagnostics.lastConnectError = `connect_error:${ip}`
      if (this.chatSockets.get(ip) === socket) this.chatSockets.delete(ip)
    })

    socket.on('message', (data) => {
      if (this.isDuplicateChatMessage(data)) return
      this.touchChatPeer(data.fromIp, { name: data.from, status: 'online' })
      this.touchPeer(data.fromIp, data.from)
      this.app.emit('chat-message', data)
    })
    socket.on('private-message', (data) => {
      this.touchChatPeer(data.fromIp, { name: data.from, status: 'online' })
      this.touchPeer(data.fromIp, data.from)
      this.app.emit('private-message', data)
    })
    socket.on('typing', (data) => this.app.emit('chat-typing', data))
    socket.on('private-typing', (data) => this.app.emit('private-typing', data))
    socket.on('history', (messages) => {
      this.chatMessages = messages || []
      this.app.emit('chat-history', messages || [])
    })
    socket.on('private-history', (data) => this.app.emit('private-history', data))

    return socket
  }

  emitToPeer(peerIp, eventName, payload, ackHandler = null) {
    if (!peerIp || peerIp === this.localIp) return false
    const socket = this.connectToChatPeer(peerIp)
    if (!socket) return false

    if (socket.connected) {
      if (ackHandler) socket.emit(eventName, payload, ackHandler)
      else socket.emit(eventName, payload)
      return true
    }

    socket.once('connect', () => {
      if (ackHandler) socket.emit(eventName, payload, ackHandler)
      else socket.emit(eventName, payload)
    })
    return true
  }

  emitPrivateMessageStatus(statusPayload) {
    this.app.emit('private-message-status', statusPayload)
  }

  broadcastChatPeers() {
    this.app.emit('chat-peers-updated', Array.from(this.chatPeers.values()))
  }

  touchChatPeer(ip, updates = {}) {
    if (!ip || ip === 'unknown' || ip === this.localIp) return
    const existing = this.chatPeers.get(ip) || {}
    this.chatPeers.set(ip, {
      ip,
      name: updates.name || existing.name || ip,
      color: updates.color || existing.color || getColorFromName(updates.name || existing.name || ip),
      pingSound: updates.pingSound || existing.pingSound || 'chime',
      status: updates.status || existing.status || 'online',
      avatar: updates.avatar !== undefined ? updates.avatar : (existing.avatar || null),
      lastSeen: Date.now()
    })
    this.broadcastChatPeers()
  }

  touchPeer(ip, name = null, color = null) {
    if (!ip || ip === 'unknown' || ip === this.localIp) return
    const existing = this.peers.get(ip)
    this.peers.set(ip, {
      ip,
      name: name || existing?.name || ip,
      color: color || existing?.color || getColorFromName(name || ip),
      lastSeen: Date.now()
    })
    this.broadcastPeers()
  }

  sendChatMessage(text) {
    const message = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2),
      from: this.displayName,
      fromIp: this.localIp,
      text,
      timestamp: Date.now(),
      type: 'group'
    }

    this.isDuplicateChatMessage(message)
    this.chatMessages.push(message)
    if (this.chatMessages.length > 200) this.chatMessages = this.chatMessages.slice(-200)

    if (this.chatServer) this.chatServer.emit('message', message)
    this.app.emit('chat-message', message)
  }

  sendPrivateMessage(toIp, text) {
    if (!toIp || !text) return
    const message = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2),
      from: this.displayName,
      fromIp: this.localIp,
      toIp,
      text,
      timestamp: Date.now(),
      type: 'private'
    }

    const chatKey = [this.localIp, toIp].sort().join('-')
    if (!this.privateChats.has(chatKey)) this.privateChats.set(chatKey, [])
    this.privateChats.get(chatKey).push(message)

    this.emitPrivateMessageStatus({ id: message.id, toIp, status: 'sending' })
    this.sendPrivateMessageAttempt(message, 0)
    this.app.emit('private-message', message)
  }

  sendTypingIndicator() {
    if (this.chatServer) {
      this.chatServer.emit('typing', { from: this.displayName, fromIp: this.localIp })
    }
  }

  sendPrivateTyping(toIp) {
    if (!toIp) return
    const delivered = this.emitToPeer(toIp, 'private-typing', {
      from: this.displayName,
      fromIp: this.localIp,
      toIp
    })
    if (!delivered && this.chatServer) {
      this.chatServer.emit('private-typing', { from: this.displayName, fromIp: this.localIp, toIp })
    }
  }

  sendPrivateMessageAttempt(message, attempt) {
    const maxRetries = 2
    const timeoutMs = 2500 + (attempt * 1000)
    const key = message.id

    const existingTimer = this.privateMessageRetries.get(key)
    if (existingTimer) clearTimeout(existingTimer)

    let acked = false
    const delivered = this.emitToPeer(message.toIp, 'private-message', message, (ack) => {
      acked = true
      const retryTimer = this.privateMessageRetries.get(key)
      if (retryTimer) {
        clearTimeout(retryTimer)
        this.privateMessageRetries.delete(key)
      }
      if (ack?.ok) this.emitPrivateMessageStatus({ id: message.id, toIp: message.toIp, status: 'sent' })
      else this.emitPrivateMessageStatus({ id: message.id, toIp: message.toIp, status: 'failed', error: 'peer-rejected' })
    })

    if (!delivered) {
      this.emitPrivateMessageStatus({ id: message.id, toIp: message.toIp, status: 'failed', error: 'no-route' })
      return
    }

    const timer = setTimeout(() => {
      if (acked) return
      this.privateMessageRetries.delete(key)
      if (attempt < maxRetries) {
        this.emitPrivateMessageStatus({ id: message.id, toIp: message.toIp, status: 'retrying', attempt: attempt + 1 })
        this.sendPrivateMessageAttempt(message, attempt + 1)
      } else {
        this.emitPrivateMessageStatus({ id: message.id, toIp: message.toIp, status: 'failed', error: 'timeout' })
      }
    }, timeoutMs)

    this.privateMessageRetries.set(key, timer)
  }

  getPrivateChatHistory(targetIp, sourceIp = this.localIp) {
    if (!targetIp || !sourceIp) return []
    const chatKey = [sourceIp, targetIp].sort().join('-')
    return [...(this.privateChats.get(chatKey) || [])]
  }

  updateStatus(status) {
    this.status = status
    if (this.chatServer) this.chatServer.emit('status-update', { status })
  }

  startDiscovery() {
    this.mdns.on('response', (response) => {
      this.diagnostics.mdnsResponsesReceived += 1
      this.diagnostics.lastMdnsResponseAt = Date.now()

      const records = [...response.answers, ...response.additionals]
      const isRelevant = records.some((r) => r.name === this.serviceName || r.name.includes('_pings'))
      if (!isRelevant) return

      const ptrRecords = records.filter((r) => r.type === 'PTR' && r.name === this.serviceName)
      let instanceNames = ptrRecords.map((r) => r.data).filter(Boolean)
      if (instanceNames.length === 0) {
        // Fallback: some environments emit SRV/TXT without PTR in the same packet.
        instanceNames = records
          .filter((r) => r.type === 'SRV' && typeof r.name === 'string' && r.name.includes('_pings._tcp.local'))
          .map((r) => r.name)
      }
      if (instanceNames.length === 0) {
        this.harvestPeerIpsFromARecords(records)
        return
      }

      for (const instanceName of instanceNames) {
        const srvRecord = records.find((r) => r.type === 'SRV' && r.name === instanceName)
        const txtRecord = records.find((r) => r.type === 'TXT' && r.name === instanceName)
        const targetHost = srvRecord?.data?.target

        let ip = null
        if (targetHost) {
          const aRecord = records.find((r) => r.type === 'A' && r.name === targetHost)
          if (aRecord) ip = aRecord.data
        }

        if (!ip) {
          if (targetHost && this.mdns) this.mdns.query(targetHost, 'A')
          continue
        }

        if (ip === this.localIp) continue

        let name = null
        if (txtRecord?.data) {
          const entry = txtRecord.data.find((d) => d.toString().startsWith('name='))
          if (entry) name = entry.toString().split('=')[1]
        }
        name = name || ip

        const existingPeer = this.peers.get(ip)
        const color = existingPeer ? existingPeer.color : getColorFromName(name)
        if (!existingPeer) this.connectToChatPeer(ip)
        this.diagnostics.lastDiscoveryPeerIp = ip
        this.peers.set(ip, { name, ip, lastSeen: Date.now(), color })
      }

      // Additional fallback for partial packets with extra A records.
      this.harvestPeerIpsFromARecords(records)
      this.broadcastPeers()
    })

    this.mdns.on('query', (query) => {
      this.diagnostics.mdnsQueriesReceived += 1
      this.diagnostics.lastMdnsQueryAt = Date.now()
      if (query.questions.some((q) => q.name === this.serviceName)) this.announce()
    })
  }

  harvestPeerIpsFromARecords(records) {
    let changed = false
    for (const record of records) {
      if (record.type !== 'A') continue
      const ip = record.data
      if (!ip || ip === this.localIp) continue
      if (!isPrivateIpv4(ip) && !isCarrierGradeNatIpv4(ip)) continue
      const existing = this.peers.get(ip)
      if (!existing) {
        this.connectToChatPeer(ip)
        this.diagnostics.lastDiscoveryPeerIp = ip
      }
      this.peers.set(ip, {
        ip,
        name: existing?.name || ip,
        color: existing?.color || getColorFromName(existing?.name || ip),
        lastSeen: Date.now()
      })
      changed = true
    }
    if (changed) this.broadcastPeers()
  }

  query() {
    if (!this.mdns) return
    this.diagnostics.mdnsQueriesSent += 1
    this.diagnostics.lastQuerySentAt = Date.now()
    this.mdns.query(this.serviceName, 'PTR')
  }

  announce() {
    if (!this.mdns) return
    this.localIp = this.getLocalIp()
    this.diagnostics.mdnsAnnouncementsSent += 1
    this.diagnostics.lastAnnounceAt = Date.now()
    this.mdns.respond({
      answers: [
        { name: this.serviceName, type: 'PTR', data: this.instanceName },
        { name: this.instanceName, type: 'SRV', data: { port: PING_PORT, target: `${this.hostname}.local` } },
        { name: this.instanceName, type: 'TXT', data: [`name=${this.displayName}`] },
        { name: `${this.hostname}.local`, type: 'A', data: this.localIp }
      ]
    })
  }

  cleanupPeers() {
    const now = Date.now()
    let changed = false
    for (const [ip, peer] of this.peers.entries()) {
      if (now - peer.lastSeen > 30000) {
        this.peers.delete(ip)
        changed = true
      }
    }
    if (changed) this.broadcastPeers()
  }

  maybeProbeSubnet() {
    const now = Date.now()
    if (this.isSubnetProbeRunning) return
    if (this.peers.size > 0) return
    if (!this.localIp || this.localIp === '127.0.0.1') return
    if (now - this.lastSubnetProbeAt < 60000) return
    this.lastSubnetProbeAt = now
    this.diagnostics.lastSubnetProbeAt = now
    this.probeLocalSubnet().catch(() => {})
  }

  bootstrapFromDiscoveryNode() {
    const nodeIp = this.discoveryNodeIp
    if (!nodeIp || nodeIp === this.localIp) return

    this.diagnostics.lastNodeConnectAttemptAt = Date.now()
    const socket = this.connectToChatPeer(nodeIp)
    if (!socket) return

    const requestPeers = () => {
      this.diagnostics.lastNodeConnectSuccessAt = Date.now()
      socket.emit('peer-list-request', {}, (response) => {
        const peers = response?.peers || []
        this.diagnostics.lastPeerListSyncAt = Date.now()
        this.diagnostics.lastPeerListCount = peers.length
        for (const peer of peers) {
          if (!peer?.ip || peer.ip === this.localIp) continue
          this.touchPeer(peer.ip, peer.name, peer.color)
          this.connectToChatPeer(peer.ip)
        }
      })
    }

    if (socket.connected) requestPeers()
    else socket.once('connect', requestPeers)
  }

  async probeLocalSubnet() {
    this.isSubnetProbeRunning = true
    let hits = 0
    try {
      const parts = this.localIp.split('.').map((v) => Number(v))
      if (parts.length !== 4 || parts.some((v) => Number.isNaN(v))) return

      const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`
      const self = parts[3]
      const candidates = []
      for (let i = 1; i <= 254; i++) {
        if (i === self) continue
        candidates.push(`${prefix}.${i}`)
      }

      const concurrency = 8
      const workers = Array.from({ length: concurrency }, async () => {
        while (candidates.length > 0) {
          const ip = candidates.pop()
          if (!ip) return
          const open = await this.isChatPortOpen(ip)
          if (open) {
            hits += 1
            this.diagnostics.lastSubnetHitIp = ip
            this.connectToChatPeer(ip)
          }
        }
      })
      await Promise.all(workers)
    } finally {
      this.diagnostics.lastSubnetProbeHits = hits
      this.isSubnetProbeRunning = false
    }
  }

  isChatPortOpen(ip) {
    return new Promise((resolve) => {
      const socket = new net.Socket()
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        try { socket.destroy() } catch {}
        resolve(value)
      }

      socket.setTimeout(300)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
      socket.connect(CHAT_PORT, ip)
    })
  }

  getLocalIp() {
    const candidates = this.getNetworkInterfaces()
    if (this.preferredIp) {
      const preferred = candidates.find((candidate) => candidate.address === this.preferredIp)
      if (preferred) return preferred.address
    }
    if (candidates.length === 0) return '127.0.0.1'
    return candidates[0].address
  }

  broadcastPeers() {
    this.app.emit('peers-updated', Array.from(this.peers.values()))
  }

  sendPing(ip, message = '', soundOverride = null, shape = 'circle') {
    const socket = io(`http://${ip}:${PING_PORT}`, {
      timeout: 5000,
      reconnection: false
    })

    socket.on('connect', () => {
      socket.emit('ping-user', {
        from: this.displayName,
        message,
        sound: soundOverride || this.pingSound,
        shape: shape || 'circle'
      })
      setTimeout(() => socket.disconnect(), 500)
    })

    socket.on('connect_error', (err) => {
      console.error(`[Pings] Ping failed to ${ip}:`, err.message)
    })
  }

  isDuplicateChatMessage(message) {
    const now = Date.now()
    for (const [key, ts] of this.seenChatMessages.entries()) {
      if (now - ts > 15000) this.seenChatMessages.delete(key)
    }

    const idKey = message?.id ? `id:${message.id}` : null
    const sigKey = `sig:${message?.fromIp || message?.from || 'unknown'}:${message?.text || ''}:${Math.floor((message?.timestamp || now) / 2000)}`

    if ((idKey && this.seenChatMessages.has(idKey)) || this.seenChatMessages.has(sigKey)) return true
    if (idKey) this.seenChatMessages.set(idKey, now)
    this.seenChatMessages.set(sigKey, now)
    return false
  }
}
