/**
 * Minimal RFC 6455 WebSocket server-side connection.
 *
 * Only what a OneBot v11 reverse-WS client needs: text frames, ping/pong,
 * close, fragmentation and a hard payload cap. No extensions, no permessage
 * deflate, no client mode.
 */
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_PAYLOAD = 32 * 1024 * 1024

export function attachWebSocket(server, { verify, onConnection } = {}) {
  const onUpgrade = (req, socket) => {
    let url
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      socket.destroy()
      return
    }
    if (verify && !verify(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const conn = new WebSocketConnection(socket)
    try {
      onConnection && onConnection(conn, req)
    } catch {
      conn.close(1011)
    }
  }
  server.on('upgrade', onUpgrade)
  return () => server.off('upgrade', onUpgrade)
}

export class WebSocketConnection {
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.fragments = null
    this.closed = false
    this.listeners = { message: [], close: [] }
    try {
      socket.setNoDelay(true)
      socket.setTimeout(0)
    } catch {}
    socket.on('data', chunk => this.onData(chunk))
    socket.on('close', () => this.emitClose())
    socket.on('error', () => this.emitClose())
  }

  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(fn)
    return this
  }

  emit(event, ...args) {
    for (const fn of this.listeners[event] || []) {
      try {
        fn(...args)
      } catch {}
    }
  }

  emitClose() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    // Bound the pending input; OneBot events are small JSON objects.
    if (this.buffer.length > MAX_PAYLOAD + 1024) {
      this.close(1009)
      return
    }
    while (this.parseFrame()) {
      if (this.closed) return
    }
  }

  parseFrame() {
    const b = this.buffer
    if (b.length < 2) return false
    const fin = (b[0] & 0x80) !== 0
    const opcode = b[0] & 0x0f
    const masked = (b[1] & 0x80) !== 0
    let length = b[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (b.length < 4) return false
      length = b.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (b.length < 10) return false
      const high = b.readUInt32BE(2)
      if (high !== 0) {
        this.close(1009)
        return false
      }
      length = b.readUInt32BE(6)
      offset = 10
    }
    if (length > MAX_PAYLOAD) {
      this.close(1009)
      return false
    }
    if (!masked) {
      // Clients must mask; an unmasked frame is a protocol error.
      this.close(1002)
      return false
    }
    if (b.length < offset + 4 + length) return false
    const mask = b.subarray(offset, offset + 4)
    offset += 4
    const payload = Buffer.from(b.subarray(offset, offset + length))
    for (let i = 0; i < length; i++) payload[i] ^= mask[i % 4]
    this.buffer = b.subarray(offset + length)
    this.onFrame(fin, opcode, payload)
    return true
  }

  onFrame(fin, opcode, payload) {
    switch (opcode) {
      case 0x8:
        this.close(1000)
        return
      case 0x9:
        this.sendFrame(0xa, payload)
        return
      case 0xa:
        return
      case 0x1:
      case 0x2:
        if (fin) {
          this.emit('message', payload.toString('utf8'))
        } else {
          this.fragments = [payload]
        }
        return
      case 0x0:
        if (!this.fragments) {
          this.close(1002)
          return
        }
        this.fragments.push(payload)
        if (fin) {
          const all = Buffer.concat(this.fragments)
          this.fragments = null
          this.emit('message', all.toString('utf8'))
        }
        return
      default:
        this.close(1002)
    }
  }

  sendFrame(opcode, payload) {
    const length = payload.length
    let header
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length])
    } else if (length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeUInt32BE(0, 2)
      header.writeUInt32BE(length, 6)
    }
    try {
      this.socket.write(Buffer.concat([header, payload]))
    } catch {}
  }

  send(text) {
    if (this.closed) return false
    this.sendFrame(0x1, Buffer.from(String(text), 'utf8'))
    return true
  }

  close(code = 1000) {
    if (this.closed) return
    this.closed = true
    try {
      const body = Buffer.alloc(2)
      body.writeUInt16BE(code, 0)
      this.sendFrame(0x8, body)
      this.socket.end()
    } catch {}
    this.emit('close')
  }
}
