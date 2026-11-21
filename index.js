/**
 * dsh-qqbot — connect a QQ account (OneBot v11 reverse WebSocket, e.g. NapCat)
 * to DeepSeek Harness, so an allow-listed QQ number can drive a real DSH agent
 * on this computer from inside QQ, and send/receive files.
 *
 * Host-only plugin: no client bundle is required for v1. All knobs live in the
 * plugin Config form (Plugins → QQ 机器人 → configure), and every knob is
 * applied to the bot's agent (sandbox mode, approval policy, tool masking).
 */
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { attachWebSocket } from './lib/websocket.js'
import { OneBotClient, messageToText } from './lib/onebot.js'
// Vendored (MIT) so the bundle also loads when installed from a plain directory:
// a linked bundle resolves modules from the workspace, where DSH's own packages
// are not present. See vendor/*/LICENSE.
import z from './vendor/schemastery/index.mjs'

export const name = 'qqbot'
export const inject = ['agents', 'approval', 'agentDefaultModel']

const PREFIX = '[qqbot]'
const log = (...args) => console.log(PREFIX, ...args)
const warn = (...args) => console.warn(PREFIX, ...args)

const MODES = ['safe', 'standard', 'full']

export const Config = z.object({
  napcatWebui: z.string().default('http://127.0.0.1:6099').description('NapCat WebUI 地址：用于检测是否启动，并提供一键跳转。'),
  frontendMode: z.string().default('direct').description('接入方式：direct（DSH 直接接管 QQ 消息）/ astrbot（AstrBot 收消息，DSH 通过 /bridge 执行）。'),
  astrbotWebui: z.string().default('http://127.0.0.1:6185').description('AstrBot WebUI 地址：用于检测是否启动，并提供一键跳转。'),
  enabled: z.boolean().default(true).description('总开关。关闭后不再监听任何端口。'),
  host: z.string().default('127.0.0.1').description('监听地址。保持 127.0.0.1 最安全。'),
  port: z.number().default(6700).description('OneBot 反向 WebSocket 端口（NapCat 里填这里）。'),
  accessToken: z.string().default('').description('可选。OneBot 的 access token；填了以后 NapCat 必须带同一个 token。'),
  owners: z.array(z.string()).default([]).description('允许指挥 bot 的 QQ 号列表（建议只填你自己的号）。'),
  extraAllowed: z.array(z.string()).default([]).description('额外的只读/受限用户 QQ 号（目前与 owners 同权，谨慎添加）。'),
  workspace: z.string().default('').description('bot 的工作目录（绝对路径）。为空则用 DSH 进程当前目录。'),
  permissionMode: z.string().default('standard').description('权限档位：safe（只读）/ standard（工作区可写 + 危险操作审批）/ full（完全放开，不审批）。'),
  allowShell: z.boolean().default(true).description('standard/full 下是否允许执行命令（bash/pwsh）。'),
  allowDesktop: z.boolean().default(true).description('是否允许操作桌面（desktop_control 等）。'),
  allowBrowser: z.boolean().default(true).description('是否允许使用浏览器工具。'),
  allowFileSend: z.boolean().default(true).description('是否允许 bot 通过 QQ 发送文件。'),
  sendRoots: z.array(z.string()).default([]).description('除工作目录外，允许发送的文件目录（绝对路径）。'),
  approvalForward: z.boolean().default(true).description('危险操作是否转发到 QQ 让 owner 批准（超时自动拒绝）。'),
  approvalTimeoutSec: z.number().default(180).description('审批超时秒数，超时按拒绝处理。'),
  maxReplyChars: z.number().default(1800).description('单条 QQ 回复的最大字符数，超出会拆成多条。'),
  provider: z.string().default('').description('bot 会话使用的 provider（留空则用 DSH 的默认模型）。'),
  model: z.string().default('').description('bot 会话使用的模型 id（留空则用 DSH 的默认模型）。'),
  reasoningEffort: z.string().default('').description('推理档位（可选，留空用默认）。'),
  systemPromptExtra: z.string().default('').description('追加给 bot 的系统提示词（可选）。'),
})

/** Normalize user-facing config into the shape the runtime uses. */
function normalizeConfig(raw) {
  const cfg = { ...(raw || {}) }
  cfg.host = String(cfg.host || '127.0.0.1')
  cfg.port = Number(cfg.port) > 0 ? Number(cfg.port) : 6700
  cfg.accessToken = String(cfg.accessToken || '')
  cfg.owners = (cfg.owners || []).map(v => String(v).trim()).filter(Boolean)
  cfg.extraAllowed = (cfg.extraAllowed || []).map(v => String(v).trim()).filter(Boolean)
  cfg.workspace = cfg.workspace ? resolve(String(cfg.workspace)) : process.cwd()
  cfg.permissionMode = MODES.includes(cfg.permissionMode) ? cfg.permissionMode : 'standard'
  cfg.allowShell = cfg.allowShell !== false
  cfg.allowDesktop = cfg.allowDesktop !== false
  cfg.allowBrowser = cfg.allowBrowser !== false
  cfg.allowFileSend = cfg.allowFileSend !== false
  cfg.sendRoots = (cfg.sendRoots || []).map(v => resolve(String(v))).filter(Boolean)
  cfg.approvalForward = cfg.approvalForward !== false
  cfg.approvalTimeoutSec = Number(cfg.approvalTimeoutSec) > 0 ? Number(cfg.approvalTimeoutSec) : 180
  cfg.maxReplyChars = Math.max(200, Number(cfg.maxReplyChars) || 1800)
  cfg.systemPromptExtra = String(cfg.systemPromptExtra || '')
  cfg.napcatWebui = String(cfg.napcatWebui || 'http://127.0.0.1:6099')
  cfg.astrbotWebui = String(cfg.astrbotWebui || 'http://127.0.0.1:6185')
  cfg.frontendMode = ['direct', 'astrbot'].includes(cfg.frontendMode) ? cfg.frontendMode : 'direct'
  return cfg
}

/** Map the three permission presets to sandbox + approval + tool masks. */
function permissionPlan(cfg) {
  switch (cfg.permissionMode) {
    case 'safe':
      return { sandbox: 'read-only', approval: 'ask', readOnlyTools: true }
    case 'full':
      return { sandbox: 'danger-full-access', approval: 'never', readOnlyTools: false }
    default:
      return { sandbox: 'workspace-write', approval: 'ask', readOnlyTools: false }
  }
}

const MUTATING_TOOLS = [
  'bash',
  'pwsh',
  'write',
  'edit',
  'apply_patch',
  'desktop_control',
  'desktop_sequence',
]

const BROWSER_TOOLS = [
  'browser_open',
  'browser_click',
  'browser_type',
  'browser_navigate',
  'browser_screenshot',
  'browser_eval',
  'browser_close',
]

class QQBot {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = normalizeConfig(config)
    this.http = null
    this.detach = null
    this.conn = null
    this.client = null
    this.selfId = ''
    this.startedAt = Date.now()
    this.agents = new Map()
    this.creating = new Map()
    this.sessionUins = new Map()
    this.sessionIdByUin = new Map()
    this.pendingApprovals = new Map()
    this.seenMessages = new Map()
    this.deniedNoticeAt = new Map()
    this.replyBuffers = new Map()
    this.bridgeWaiters = new Map()
    this.setSandboxMode = null
    this.stopping = false
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    if (!this.config.enabled) {
      log('disabled in config')
      return
    }
    try {
      const mod = await import('@deepseek-ai/dsh-sandbox-policy')
      if (typeof mod.setSandboxMode === 'function') this.setSandboxMode = mod.setSandboxMode
    } catch (err) {
      warn('sandbox-policy import failed, falling back to session.append:', err?.message || err)
    }
    if (!this.setSandboxMode) {
      this.setSandboxMode = (session, mode) => session.append('sandbox/mode', { mode })
    }

    this.http = createServer((req, res) => this.handleHttp(req, res))
    this.detach = attachWebSocket(this.http, {
      verify: (req, url) => this.verifyToken(req, url),
      onConnection: (conn, req) => this.onConnection(conn, req),
    })
    await new Promise((resolvePromise, rejectPromise) => {
      const onError = err => {
        this.http.off('listening', onListening)
        rejectPromise(err)
      }
      const onListening = () => {
        this.http.off('error', onError)
        resolvePromise()
      }
      this.http.once('error', onError)
      this.http.once('listening', onListening)
      this.http.listen(this.config.port, this.config.host)
    })
    this.http.on('error', err => warn('http server error:', err?.message || err))
    log(`listening on ws://${this.config.host}:${this.config.port} (OneBot v11 reverse WS)`)
    log(`permission=${this.config.permissionMode} workspace=${this.config.workspace}`)
    if (this.config.owners.length === 0) {
      warn('no owner QQ configured — every incoming message will be refused until you set owners')
    }
  }

  stop() {
    this.stopping = true
    for (const [id, entry] of this.pendingApprovals) {
      clearTimeout(entry.timer)
      entry.resolve('rejected')
      this.pendingApprovals.delete(id)
    }
    for (const handle of this.agents.values()) {
      try {
        handle.dispose()
      } catch {}
    }
    this.agents.clear()
    this.creating.clear()
    this.sessionUins.clear()
    this.sessionIdByUin.clear()
    try {
      this.conn?.close(1001)
    } catch {}
    this.conn = null
    this.client = null
    try {
      this.detach?.()
    } catch {}
    this.detach = null
    if (this.http) {
      try {
        this.http.close()
      } catch {}
      this.http = null
    }
    log('stopped')
  }

  // ------------------------------------------------------------------ network

  verifyToken(req, url) {
    const token = this.config.accessToken
    if (!token) return true
    const auth = String(req.headers.authorization || '')
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const query = url.searchParams.get('access_token') || ''
    return bearer === token || query === token
  }

  onConnection(conn, req) {
    if (this.conn && !this.conn.closed) {
      try {
        this.conn.close(1001)
      } catch {}
    }
    this.conn = conn
    this.client = new OneBotClient(conn)
    log(`client connected from ${req.socket?.remoteAddress || '?'} ${req.url || ''}`)
    this.client.on('event', ev => this.onEvent(ev))
    this.client.on('close', () => {
      if (this.conn === conn) {
        this.conn = null
        this.client = null
        log('client disconnected')
      }
    })
    // Ask who we are; harmless if the client answers or not.
    setTimeout(() => {
      this.client?.call('get_login_info').then(info => {
        if (info?.user_id) this.selfId = String(info.user_id)
      }).catch(() => {})
    }, 300)
  }

  async handleHttp(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    const url = req.url || '/'
    if (url.startsWith('/bridge')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Headers': 'content-type' })
        res.end()
        return
      }
      await this.handleBridge(req, res)
      return
    }
    if (url === '/' || url.startsWith('/?')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh-qqbot: connect a OneBot v11 client to ws://' + this.config.host + ':' + this.config.port + '/\n')
      return
    }
    if (url.startsWith('/peers')) {
      const [napcat, astrbot] = await Promise.all([
        probeTcp(this.config.napcatWebui),
        probeTcp(this.config.astrbotWebui),
      ])
      const body = {
        ok: true,
        napcat,
        astrbot,
        onebot: { connected: Boolean(this.conn && !this.conn.closed), selfId: this.selfId || '' },
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
      return
    }
    if (url.startsWith('/status')) {
      const body = {
        ok: true,
        connected: Boolean(this.conn && !this.conn.closed),
        selfId: this.selfId,
        permissionMode: this.config.permissionMode,
        workspace: this.config.workspace,
        owners: this.config.owners,
        sessions: [...this.agents.keys()],
        lastError: this.lastError || '',
        uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }

  // ------------------------------------------------------------------- events

  onEvent(ev) {
    if (!ev || typeof ev !== 'object') return
    if (ev.self_id) this.selfId = String(ev.self_id)
    if (ev.post_type === 'meta_event') {
      if (ev.meta_event_type === 'lifecycle' && ev.sub_type === 'connect') {
        log(`OneBot client online: ${this.selfId}`)
      }
      return
    }
    if (ev.post_type === 'message' && ev.message_type === 'private') {
      this.onPrivateMessage(ev).catch(err => {
        this.lastError = String(err?.stack || err)
        warn('message handling failed:', err?.stack || err)
      })
    }
  }

  isAllowed(uin) {
    return this.config.owners.includes(uin) || this.config.extraAllowed.includes(uin)
  }

  async onPrivateMessage(ev) {
    const uin = String(ev.user_id)
    // In astrbot mode AstrBot owns the QQ conversation; it forwards work through
    // /bridge. Ignore OneBot inbound here so the two never answer the same message.
    if (this.config.frontendMode === 'astrbot') return
    const messageId = ev.message_id !== undefined ? String(ev.message_id) : ''
    if (messageId) {
      if (this.seenMessages.has(messageId)) return
      this.seenMessages.set(messageId, Date.now())
      if (this.seenMessages.size > 500) {
        const cutoff = Date.now() - 10 * 60 * 1000
        for (const [id, at] of this.seenMessages) if (at < cutoff) this.seenMessages.delete(id)
      }
    }
    const text = messageToText(ev.message)
    if (!text) {
      await this.sendText(uin, '（这条消息里没有可读的文字；图片和语音暂时处理不了）')
      return
    }
    if (!this.isAllowed(uin)) {
      const last = this.deniedNoticeAt.get(uin) || 0
      if (Date.now() - last > 10 * 60 * 1000) {
        this.deniedNoticeAt.set(uin, Date.now())
        await this.sendText(uin, '你没有使用这台电脑上的 bot 的权限。')
      }
      return
    }
    if (text.startsWith('/')) {
      await this.onCommand(uin, text)
      return
    }
    await this.ensureAgent(uin)
    const handle = this.agents.get(uin)
    if (!handle) return
    const prefix = `[QQ 私聊] QQ ${uin} 发来：`
    handle.agent.followup({
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text: text }],
      source: { kind: 'user' },
    })
    void prefix
  }

  // ---------------------------------------------------------------- bridge API
  //
  // For setups where another framework (AstrBot, NoneBot, ...) already owns the
  // QQ connection: that framework POSTs the prompt here and sends the reply back
  // itself. We never talk to QQ in this path, so both sides can coexist.

  async handleBridge(req, res) {
    const json = (code, body) => {
      try {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      } catch {}
    }
    const remote = req.socket?.remoteAddress || ''
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    let body
    try {
      body = JSON.parse((await readRequestBody(req)) || '{}')
    } catch {
      return json(400, { ok: false, error: '请求体不是合法 JSON' })
    }
    if (!loopback && !this.config.accessToken) {
      return json(403, { ok: false, error: '桥接默认只接受本机请求；远程使用请在设置里配置 Access Token' })
    }
    if (this.config.accessToken && String(body.token || '') !== this.config.accessToken) {
      return json(403, { ok: false, error: 'Access Token 不匹配' })
    }
    const uin = String(body.user_id || '').trim()
    const text = String(body.text || '').trim()
    if (!uin || !text) return json(400, { ok: false, error: '需要 user_id 和 text' })
    if (!this.isAllowed(uin)) return json(403, { ok: false, error: '这个 QQ 不在 owner 列表里' })
    if (this.bridgeWaiters.has(uin)) return json(429, { ok: false, error: '上一条还在处理，请稍等' })
    try {
      const reply = await this.runBridgeTurn(uin, text)
      return json(200, { ok: true, replies: reply ? this.splitText(reply) : [] })
    } catch (err) {
      return json(500, { ok: false, error: String(err?.message || err) })
    }
  }

  runBridgeTurn(uin, text) {
    return this.ensureAgent(uin).then(handle => new Promise((resolve, reject) => {
      if (!handle) return reject(new Error('agent unavailable'))
      const timer = setTimeout(() => {
        this.bridgeWaiters.delete(uin)
        reject(new Error('等待回复超时（10 分钟）'))
      }, 10 * 60 * 1000)
      this.bridgeWaiters.set(uin, { resolve, reject, timer })
      try {
        handle.agent.followup({
          role: 'user',
          id: randomUUID(),
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
      } catch (err) {
        clearTimeout(timer)
        this.bridgeWaiters.delete(uin)
        reject(err)
      }
    }))
  }

  // ----------------------------------------------------------------- commands

  async onCommand(uin, text) {
    const [rawCmd, ...rest] = text.trim().split(/\s+/)
    const cmd = rawCmd.toLowerCase()
    switch (cmd) {
      case '/help':
        await this.sendText(uin, [
          '可用指令：',
          '/status  查看连接、权限和会话状态',
          '/reset   清空这个 QQ 的会话（会丢失上下文）',
          '/stop    中断当前正在跑的任务',
          '/allow <id> /deny <id>  批准或拒绝一次工具审批',
          '直接发普通文字就是给 DSH 下指令。',
        ].join('\n'))
        return
      case '/status': {
        const plan = permissionPlan(this.config)
        await this.sendText(uin, [
          `连接：${this.conn && !this.conn.closed ? '在线' : '离线'}${this.selfId ? `（bot ${this.selfId}）` : ''}`,
          `权限：${this.config.permissionMode}（沙箱 ${plan.sandbox}，审批 ${plan.approval}）`,
          `工作区：${this.config.workspace}`,
          `会话：${[...this.agents.keys()].join(', ') || '无'}`,
        ].join('\n'))
        return
      }
      case '/reset': {
        const handle = this.agents.get(uin)
        if (handle) {
          const realId = this.sessionIdByUin.get(uin)
          try {
            handle.dispose()
          } catch {}
          this.agents.delete(uin)
          if (realId) this.sessionUins.delete(realId)
          this.sessionIdByUin.delete(uin)
          await this.sendText(uin, '会话已重置。')
        } else {
          await this.sendText(uin, '当前没有会话。')
        }
        return
      }
      case '/stop': {
        const handle = this.agents.get(uin)
        if (!handle) {
          await this.sendText(uin, '当前没有会话。')
          return
        }
        try {
          handle.agent.cancel({ kind: 'user-request', reason: 'stopped from QQ' })
          await this.sendText(uin, '已请求中断当前任务。')
        } catch (err) {
          await this.sendText(uin, `中断失败：${err?.message || err}`)
        }
        return
      }
      case '/allow':
      case '/deny': {
        const id = (rest[0] || '').replace(/^#/, '')
        const outcome = cmd === '/allow' ? 'allowed-once' : 'rejected'
        if (!this.decideApproval(id, outcome)) {
          await this.sendText(uin, `没有待处理的审批 ${id ? '#' + id : ''}（可能已超时）。`)
        }
        return
      }
      default:
        await this.sendText(uin, `未知指令 ${rawCmd}，发 /help 看用法。`)
    }
  }

  // -------------------------------------------------------------- approval flow

  onApproval(uin, req, next) {
    if (!this.config.approvalForward) return next()
    if (!this.client || !this.conn || this.conn.closed) return 'rejected'
    const id = randomBytes(2).toString('hex')
    const timeoutMs = this.config.approvalTimeoutSec * 1000
    const toolName = req.toolName || req.tool || '未知工具'
    const reason = req.displayReason || req.reason || ''
    void this.sendText(uin, [
      `🔐 需要你批准一次危险操作 #${id}`,
      `工具：${toolName}`,
      reason ? `原因：${reason}` : '',
      `回复 /allow ${id} 批准一次，或 /deny ${id} 拒绝；${this.config.approvalTimeoutSec} 秒内不回复按拒绝处理。`,
    ].filter(Boolean).join('\n'))
    return new Promise(resolvePromise => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(id)
        resolvePromise('rejected')
        void this.sendText(uin, `⏱ 审批 #${id} 超时，已拒绝。`)
      }, timeoutMs)
      this.pendingApprovals.set(id, {
        uin,
        timer,
        resolve: outcome => {
          clearTimeout(timer)
          resolvePromise(outcome)
        },
      })
    })
  }

  decideApproval(id, outcome) {
    const entry = this.pendingApprovals.get(id)
    if (!entry) return false
    this.pendingApprovals.delete(id)
    entry.resolve(outcome)
    void this.sendText(entry.uin, outcome === 'allowed-once' ? `✅ 已批准 #${id}（仅这一次）。` : `⛔ 已拒绝 #${id}。`)
    return true
  }

  // ------------------------------------------------------------------- agents

  async ensureAgent(uin) {
    if (this.agents.has(uin)) return this.agents.get(uin)
    if (this.creating.has(uin)) return this.creating.get(uin)
    const promise = this.createAgent(uin).finally(() => this.creating.delete(uin))
    this.creating.set(uin, promise)
    return promise
  }

  async createAgent(uin) {
    const sessionId = `qqbot_${uin}`
    const meta = { cwd: this.config.workspace }
    const setup = (agentCtx, agent) => this.setupAgent(agentCtx, agent, uin)
    const agentOptions = this.agentOptions()
    const previous = this.sessionIdByUin.get(uin) || sessionId
    let handle
    try {
      handle = await this.ctx.agents.resume({ resumeSessionId: previous, meta, setup, agentOptions })
      log(`resumed session ${previous}`)
    } catch {
      try {
        handle = await this.ctx.agents.create({ sessionId, meta, setup, agentOptions })
        log(`created session ${sessionId}`)
      } catch (err) {
        if (/already exists/i.test(String(err?.message || err))) {
          try {
            handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, meta, setup, agentOptions })
            log(`recovered existing session ${sessionId}`)
          } catch (resumeErr) {
            warn('stored session unusable, starting a fresh one:', resumeErr?.message || resumeErr)
            const freshId = `${sessionId}_${Date.now().toString(36)}`
            handle = await this.ctx.agents.create({ sessionId: freshId, meta, setup, agentOptions })
            this.sessionIdByUin.set(uin, freshId)
            void this.sendText(uin, '（原来的会话记录损坏，已经为你开了一个新会话；之前的内容无法恢复。）')
            log(`created fresh session ${freshId}`)
          }
        } else {
          throw err
        }
      }
    }
    this.agents.set(uin, handle)
    const realId = handle.agent.session.id
    this.sessionUins.set(realId, uin)
    this.sessionIdByUin.set(uin, realId)
    return handle
  }

  /** Provider/model route for a fresh bot agent: explicit config wins, else the deployment default. */
  agentOptions() {
    if (this.config.provider && this.config.model) {
      return this.config.reasoningEffort
        ? { provider: this.config.provider, model: this.config.model, reasoningEffort: this.config.reasoningEffort }
        : { provider: this.config.provider, model: this.config.model }
    }
    try {
      const selection = this.ctx.agentDefaultModel.currentSelection()
      if (selection?.provider && selection?.model) {
        return selection.reasoningEffort
          ? { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }
          : { provider: selection.provider, model: selection.model }
      }
    } catch (err) {
      warn('default model lookup failed:', err?.message || err)
    }
    return undefined
  }

  setupAgent(agentCtx, agent, uin) {
    const plan = permissionPlan(this.config)
    try {
      this.setSandboxMode(agent.session, plan.sandbox)
    } catch (err) {
      warn('setSandboxMode failed:', err?.message || err)
    }
    try {
      this.ctx.approval.setPolicy(agent, plan.approval)
    } catch (err) {
      warn('setApprovalPolicy failed:', err?.message || err)
    }
    this.applyToolMask(agentCtx, agent, plan)
    if (this.config.allowFileSend) {
      try {
        this.registerSendFileTool(agentCtx, uin)
      } catch (err) {
        warn('register qq_send_file failed:', err?.message || err)
      }
    }
    try {
      agentCtx.systemPrompt.section({
        name: 'qqbot-bridge',
        order: 50,
        text: this.systemPromptFor(uin, plan),
      })
    } catch (err) {
      warn('systemPrompt.section failed:', err?.message || err)
    }
    agentCtx.on('approval/request', (req, next) => this.onApproval(uin, req, next), true)
    if (agent.session?.id) this.sessionUins.set(agent.session.id, uin)
    log(`agent ready for QQ ${uin} (${plan.sandbox}/${plan.approval})`)
  }

  applyToolMask(agentCtx, agent, plan) {
    const deny = []
    if (plan.readOnlyTools) deny.push(...MUTATING_TOOLS)
    if (!this.config.allowShell) deny.push('bash', 'pwsh')
    if (!this.config.allowDesktop) deny.push('desktop_control', 'desktop_sequence')
    if (!this.config.allowBrowser) deny.push(...BROWSER_TOOLS)
    const known = [...new Set(deny)].filter(tool => {
      try {
        return agentCtx.tools.get(tool, agent) !== undefined
      } catch {
        return false
      }
    })
    if (known.length === 0) return
    try {
      agentCtx.tools.restrict({ deny: known })
    } catch (err) {
      warn('tools.restrict failed:', err?.message || err)
    }
  }

  registerSendFileTool(agentCtx, uin) {
    agentCtx.tools.register({
      name: 'qq_send_file',
      description:
        'Send a file from this computer to the QQ user currently chatting with you. '
        + 'The file must be inside the bot workspace or an allowed send directory. '
        + 'Use this whenever the user asks for a document, image, archive or any other file.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Absolute path, or a path relative to the workspace.',
        },
        name: {
          type: 'string',
          description: 'Optional display file name shown in QQ.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args) => {
        const resolved = this.resolveSendPath(args.path)
        const info = await stat(resolved)
        if (!info.isFile()) throw new Error(`不是文件：${resolved}`)
        if (info.size > 100 * 1024 * 1024) throw new Error('文件超过 100MB，QQ 可能无法接收')
        await this.uploadFile(uin, resolved, args.name || basename(resolved))
        return `已通过 QQ 发送：${basename(resolved)}（${info.size} 字节）`
      },
    })
  }


  resolveSendPath(rawPath) {
    const raw = String(rawPath || '').trim()
    if (!raw) throw new Error('path 不能为空')
    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(this.config.workspace, raw)
    const roots = [this.config.workspace, ...this.config.sendRoots]
    const allowed = roots.some(root => {
      const rel = relative(root, absolute)
      return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
    })
    if (!allowed) {
      throw new Error(`只允许发送工作区（${this.config.workspace}）或 sendRoots 内的文件：${absolute}`)
    }
    return absolute
  }

  systemPromptFor(uin, plan) {
    const lines = [
      '你正在通过 QQ 私聊与用户对话。你在用户本人的 Windows 电脑上运行，是这个电脑上的助手。',
      `当前对话的 QQ 号：${uin}。只服务这个号对应的用户。`,
      '你的回复会自动通过 QQ 发回给用户：保持简洁，避免表格和超长代码块。',
      '需要交付文件时：先把文件写进工作区，再调用 qq_send_file 工具发送；qq_send_file 只能发送工作区内或允许目录里的文件。',
      `当前权限档位：${this.config.permissionMode}（沙箱 ${plan.sandbox}，审批 ${plan.approval}）。不要声称拥有未授予的权限。`,
      `工作区：${this.config.workspace}`,
    ]
    if (this.config.systemPromptExtra.trim()) lines.push(this.config.systemPromptExtra.trim())
    return lines.join('\n')
  }

  // -------------------------------------------------------------------- replies

  onSessionEvent(session, event) {
    const uin = this.sessionUins.get(session.id) ?? this.sessionUins.get(String(session.id))
    if (!uin) return
    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content ?? event.data?.content
      const text = Array.isArray(blocks)
        ? blocks.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('')
        : ''
      if (!text) return
      const buffer = this.replyBuffers.get(uin) || ''
      this.replyBuffers.set(uin, buffer ? `${buffer}\n${text}` : text)
      return
    }
    if (event.type === 'turn/end') {
      const reason = event.data?.reason
      const text = (this.replyBuffers.get(uin) || '').trim()
      this.replyBuffers.delete(uin)
      const waiter = this.bridgeWaiters.get(uin)
      if (waiter) {
        this.bridgeWaiters.delete(uin)
        clearTimeout(waiter.timer)
        waiter.resolve(text)
        return
      }
      if (!text) {
        if (reason === 'error') void this.sendText(uin, '（这一轮出错了，没有可显示的回复）')
        return
      }
      void this.sendText(uin, text)
    }
  }

  async sendText(uin, text) {
    if (!this.client || !this.conn || this.conn.closed) {
      warn('drop reply: nobody connected')
      return
    }
    const chunks = this.splitText(text)
    for (const chunk of chunks) {
      try {
        await this.client.call('send_private_msg', {
          user_id: Number(uin),
          message: [{ type: 'text', text: chunk }],
        })
      } catch (err) {
        warn('send_private_msg failed:', err?.message || err)
        return
      }
    }
  }

  splitText(text) {
    const limit = this.config.maxReplyChars
    const value = String(text || '')
    if (value.length <= limit) return [value]
    const chunks = []
    let rest = value
    while (rest.length > limit) {
      let cut = rest.lastIndexOf('\n', limit)
      if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit)
      if (cut < limit * 0.5) cut = limit
      chunks.push(rest.slice(0, cut))
      rest = rest.slice(cut).replace(/^\n/, '')
    }
    if (rest) chunks.push(rest)
    return chunks
  }

  async uploadFile(uin, absolutePath, name) {
    if (!this.client) throw new Error('QQ 未连接，无法发送文件')
    const url = 'file:///' + absolutePath.replace(/\\/g, '/').replace(/^\//, '')
    await this.client.call('upload_private_file', {
      user_id: Number(uin),
      file: url,
      name,
    }, 120000)
  }
}

// ---------------------------------------------------------------- settings UI

const SETTINGS_KEYS = new Set([
  'enabled', 'host', 'port', 'accessToken', 'owners', 'extraAllowed', 'workspace',
  'permissionMode', 'allowShell', 'allowDesktop', 'allowBrowser', 'allowFileSend',
  'sendRoots', 'approvalForward', 'approvalTimeoutSec', 'maxReplyChars',
  'provider', 'model', 'reasoningEffort', 'systemPromptExtra',
  'frontendMode', 'napcatWebui', 'astrbotWebui',
])

const TOGGLE_KEYS = [
  'enabled', 'allowShell', 'allowDesktop', 'allowBrowser', 'allowFileSend', 'approvalForward',
]

function asStringList(value) {
  if (!Array.isArray(value)) return []
  return value.map(v => String(v).trim()).filter(Boolean)
}

/** Validate a settings patch; returns { patch } or { rejected }. */
function sanitizeSettingsPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { rejected: ['请求体必须是对象'] }
  }
  const patch = {}
  const rejected = []
  for (const [key, value] of Object.entries(raw)) {
    if (!SETTINGS_KEYS.has(key)) {
      rejected.push(`未知字段 ${key}`)
      continue
    }
    try {
      if (TOGGLE_KEYS.includes(key)) {
        patch[key] = Boolean(value)
      } else if (key === 'port') {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('端口需在 1-65535')
        patch[key] = n
      } else if (key === 'approvalTimeoutSec') {
        const n = Number(value)
        if (!Number.isFinite(n) || n < 30 || n > 3600) throw new Error('审批超时需在 30-3600 秒')
        patch[key] = Math.round(n)
      } else if (key === 'maxReplyChars') {
        const n = Number(value)
        if (!Number.isFinite(n) || n < 200 || n > 8000) throw new Error('回复上限需在 200-8000')
        patch[key] = Math.round(n)
      } else if (key === 'owners' || key === 'extraAllowed' || key === 'sendRoots') {
        patch[key] = asStringList(value)
      } else if (key === 'permissionMode') {
        if (!MODES.includes(value)) throw new Error('权限档必须是 safe / standard / full')
        patch[key] = value
      } else if (key === 'frontendMode') {
        if (!['direct', 'astrbot'].includes(value)) throw new Error('接入方式必须是 direct / astrbot')
        patch[key] = value
      } else if (key === 'workspace') {
        patch[key] = String(value || '').trim()
      } else {
        patch[key] = String(value ?? '')
      }
    } catch (err) {
      rejected.push(`${key}: ${err.message}`)
    }
  }
  return rejected.length ? { rejected } : { patch }
}

/** TCP probe for a local program's WebUI (used by the "周边程序" card). */
function probeTcp(url, timeoutMs = 700) {
  return new Promise(resolve => {
    const raw = String(url || '').trim()
    let target
    try {
      target = new URL(raw)
    } catch {
      return resolve({ url: raw, up: false, error: '地址不是合法 URL' })
    }
    const host = target.hostname || '127.0.0.1'
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
    const socket = connect({ host, port })
    let settled = false
    const done = (up, error) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch {}
      resolve({ url: raw, up, ...(error ? { error } : {}) })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false, '连接超时'))
    socket.once('error', err => done(false, String(err && err.code ? err.code : err)))
  })
}

function readRequestBody(req, cap = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > cap) {
        reject(new Error('请求体过大'))
        try { req.destroy() } catch {}
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function publicConfig(cfg) {
  const out = {}
  for (const key of SETTINGS_KEYS) out[key] = cfg[key]
  out.accessToken = ''
  out.hasToken = Boolean(cfg.accessToken)
  return out
}

/** Mount the settings routes (/api/qqbot) on the DSH web server. */
function installSettingsRoute(ctx, bot) {
  const send = (res, code, body) => {
    try {
      const text = JSON.stringify(body)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(text)
    } catch {}
  }

  const persist = patch => {
    const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : null
    const entry = ctx.fiber && ctx.fiber.entry
    if (!editor || !entry || typeof editor.edit !== 'function') return false
    setTimeout(() => {
      Promise.resolve(editor.edit(entry, current => ({ ...(current || {}), ...patch })))
        .catch(err => warn('settings: configEditor.edit failed:', err?.message || err))
    }, 150)
    return true
  }

  const handle = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const route = url.pathname.replace(/^\/api\/qqbot/, '') || '/'
    try {
      if (req.method === 'GET' && route === '/config') {
        send(res, 200, {
          ok: true,
          config: publicConfig(bot.config),
          status: {
            connected: Boolean(bot.conn && !bot.conn.closed),
            selfId: bot.selfId,
            permissionMode: bot.config.permissionMode,
            workspace: bot.config.workspace,
            sessions: [...bot.agents.keys()],
          },
        })
        return
      }
      if (req.method === 'POST' && route === '/config') {
        const text = await readRequestBody(req)
        let body
        try {
          body = JSON.parse(text || '{}')
        } catch {
          send(res, 400, { ok: false, rejected: ['请求体不是合法 JSON'] })
          return
        }
        const parsed = sanitizeSettingsPatch(body)
        if (parsed.rejected) {
          send(res, 400, { ok: false, rejected: parsed.rejected })
          return
        }
        const applied = persist(parsed.patch)
        send(res, 200, {
          ok: true,
          applied,
          note: applied ? '已写入 profile，插件正在重启' : '已接收。重启 DSH 后生效',
        })
        return
      }
      if (req.method === 'GET' && route === '/peers') {
        const [napcat, astrbot] = await Promise.all([
          probeTcp(bot.config.napcatWebui),
          probeTcp(bot.config.astrbotWebui),
        ])
        send(res, 200, {
          ok: true,
          napcat,
          astrbot,
          onebot: { connected: Boolean(bot.conn && !bot.conn.closed), selfId: bot.selfId || '' },
        })
        return
      }
      send(res, 404, { ok: false, rejected: [`没有这条路由：${route}`] })
    } catch (err) {
      send(res, 500, { ok: false, rejected: [String(err?.message || err)] })
    }
  }

  try {
    ctx.inject(['webServer'], scoped => {
      scoped.effect(() => scoped.webServer.register({
        kind: 'prefix',
        path: '/api/qqbot',
        auth: 'required',
        handler: handle,
      }), 'qqbot: settings routes')
    })
  } catch (err) {
    warn('settings routes unavailable:', String(err?.message || err))
  }
}

export function apply(ctx, config) {
  const bot = new QQBot(ctx, config)
  try {
    installSettingsRoute(ctx, bot)
  } catch (err) {
    warn('settings route install failed:', String(err?.message || err))
  }
  ctx.effect(() => {
    bot.start().catch(err => warn('start failed:', err?.stack || err))
    const off = ctx.on('session/event', (session, event) => bot.onSessionEvent(session, event))
    return () => {
      try {
        off()
      } catch {}
      bot.stop()
    }
  })
}
