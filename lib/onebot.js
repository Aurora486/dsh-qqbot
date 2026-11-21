/**
 * Tiny OneBot v11 client over an already-established WebSocket.
 *
 * - `event` fires for every event push (`post_type` present).
 * - `call(action, params)` sends an action and resolves with `data` when the
 *   matching `echo` comes back; OneBot failures reject with the retcode text.
 */
export class OneBotClient {
  constructor(conn) {
    this.conn = conn
    this.echo = 0
    this.pending = new Map()
    this.listeners = { event: [], close: [] }
    conn.on('message', text => this.onMessage(text))
    conn.on('close', () => {
      this.failAll('连接已断开')
      this.emit('close')
    })
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

  onMessage(text) {
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    if (msg.echo !== undefined && msg.echo !== null) {
      const key = String(msg.echo)
      const pending = this.pending.get(key)
      if (!pending) return
      this.pending.delete(key)
      if (msg.status === 'failed' || (typeof msg.retcode === 'number' && msg.retcode !== 0)) {
        pending.reject(new Error(msg.wording || msg.message || `OneBot 调用失败 (retcode ${msg.retcode})`))
      } else {
        pending.resolve(msg.data)
      }
      return
    }
    if (msg.post_type) this.emit('event', msg)
  }

  call(action, params = {}, timeoutMs = 60000) {
    if (!this.conn || this.conn.closed) return Promise.reject(new Error('QQ 未连接'))
    const echo = String(++this.echo)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`OneBot 动作 ${action} 超时`))
      }, timeoutMs)
      this.pending.set(echo, {
        resolve: data => {
          clearTimeout(timer)
          resolve(data)
        },
        reject: err => {
          clearTimeout(timer)
          reject(err)
        },
      })
      this.conn.send(JSON.stringify({ action, params, echo }))
    })
  }

  failAll(reason) {
    for (const pending of this.pending.values()) pending.reject(new Error(reason))
    this.pending.clear()
  }
}

/** Extract readable text from a OneBot message (array or CQ string). */
export function messageToText(message) {
  if (typeof message === 'string') return cqToText(message)
  if (!Array.isArray(message)) return ''
  const parts = []
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    switch (seg.type) {
      case 'text':
        parts.push(seg.data?.text ?? '')
        break
      case 'image':
        parts.push('[图片]')
        break
      case 'face':
        parts.push('[表情]')
        break
      case 'record':
        parts.push('[语音]')
        break
      case 'video':
        parts.push('[视频]')
        break
      case 'file':
        parts.push(`[文件 ${seg.data?.name || seg.data?.file || ''}]`)
        break
      case 'at':
        parts.push(`@${seg.data?.qq ?? ''}`)
        break
      case 'reply':
        break
      default:
        break
    }
  }
  return parts.join('').trim()
}

function cqToText(raw) {
  return String(raw)
    .replace(/\[CQ:image,[^\]]*\]/g, '[图片]')
    .replace(/\[CQ:record,[^\]]*\]/g, '[语音]')
    .replace(/\[CQ:video,[^\]]*\]/g, '[视频]')
    .replace(/\[CQ:file,[^\]]*\]/g, '[文件]')
    .replace(/\[CQ:face,[^\]]*\]/g, '[表情]')
    .replace(/\[CQ:at,[^\]]*\]/g, '')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .trim()
}
