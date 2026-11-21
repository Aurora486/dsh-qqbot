/**
 * dsh-qqbot 设置页（设置 → QQ 机器人）。
 * 零构建手写 React；id 必须等于包名；数据走同源 /api/qqbot/*。
 * 布局原则：字段竖排（标题 / 说明 / 控件），窄面板不会重叠。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-qqbot',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    const API = '/api/qqbot'
    const inject = ['slots']

    const T = {
      nav: 'QQ 机器人',
      title: 'QQ 机器人',
      sub: '在 QQ 里私聊它，让它用这台电脑干活。下面三步配完就能用。',
      loading: '读取中…',
      reload: '重新读取',
      save: '保存并生效',
      saving: '保存中…',
      saved: '已保存，插件正在重启；NapCat 会自动重连。',
      savedLocal: '已保存，重启 DSH 后生效。',
      failed: '保存失败：',
      loadFailed: '读取失败：',
    }

    const C = {
      label: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-tertiary)',
      border: 'var(--dsw-alias-border-l1)',
      bg: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      ok: 'var(--dsw-alias-state-success-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warning-primary, #b7791f)',
    }

    function api(path, init) {
      const opts = Object.assign({ method: 'GET' }, init || {})
      if (opts.body !== undefined) {
        opts.headers = { 'Content-Type': 'application/json' }
        opts.body = JSON.stringify(opts.body)
      }
      return fetch(API + path, opts).then(res =>
        res.json().catch(() => ({})).then(body => {
          if (!res.ok) {
            const why = body && body.rejected && body.rejected.join
              ? body.rejected.join('；') : ('HTTP ' + res.status)
            throw new Error(why)
          }
          return body
        })
      )
    }

    const box = { background: C.bg, border: '1px solid ' + C.border, borderRadius: 10, padding: '10px 14px' }

    function card(step, title, desc, children) {
      return h('div', { key: title, style: Object.assign({}, box, { marginTop: 12 }) },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', {
            style: {
              width: 20, height: 20, borderRadius: 10, flexShrink: 0, textAlign: 'center',
              lineHeight: '20px', fontSize: 12, fontWeight: 700, color: '#fff',
              background: 'var(--dsw-alias-brand-primary, #1f6feb)',
            },
          }, String(step)),
          h('span', { style: { color: C.label, fontSize: 14, fontWeight: 600 } }, title)),
        desc ? h('div', { style: { color: C.sub, fontSize: 12, margin: '4px 0 2px 28px', lineHeight: 1.5 } }, desc) : null,
        h('div', { style: { marginLeft: 28 } }, children))
    }

    function field(name, hint, control) {
      return h('div', { key: name, style: { margin: '10px 0' } },
        h('div', { style: { color: C.label, fontSize: 13, marginBottom: 2 } }, name),
        hint ? h('div', { style: { color: C.sub, fontSize: 11, marginBottom: 4, lineHeight: 1.5 } }, hint) : null,
        control)
    }

    const inputStyle = {
      width: '100%', boxSizing: 'border-box', padding: '6px 9px', borderRadius: 6,
      border: '1px solid ' + C.border, background: C.bg2, color: C.label, fontSize: 13,
    }

    function input(value, onChange, opts) {
      opts = opts || {}
      return h('input', {
        type: opts.type || 'text',
        value: value === undefined || value === null ? '' : String(value),
        placeholder: opts.placeholder || '',
        onChange: e => onChange(e.target.value),
        style: inputStyle,
      })
    }

    function area(value, onChange, rows) {
      return h('textarea', {
        value: value === undefined || value === null ? '' : String(value),
        rows: rows || 2,
        onChange: e => onChange(e.target.value),
        style: Object.assign({}, inputStyle, { resize: 'vertical', fontFamily: 'inherit' }),
      })
    }

    function toggle(value, onChange, text) {
      return h('div', {
        key: text,
        onClick: () => onChange(!value),
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8,
          border: '1px solid ' + C.border, cursor: 'pointer',
          background: value ? C.bg2 : 'transparent',
        },
      },
      h('span', {
        style: {
          width: 30, height: 16, borderRadius: 8, position: 'relative', flexShrink: 0,
          background: value ? C.ok : C.sub, transition: 'background .15s',
        },
      }, h('span', {
        style: {
          position: 'absolute', top: 2, left: value ? 16 : 2, width: 12, height: 12,
          borderRadius: 6, background: '#fff', transition: 'left .15s',
        },
      })),
      h('span', { style: { color: C.label, fontSize: 12 } }, text))
    }

    function permCard(value, current, onPick, title, desc) {
      const active = current === value
      return h('div', {
        key: value,
        onClick: () => onPick(value),
        style: {
          flex: '1 1 180px', minWidth: 160, padding: '9px 11px', borderRadius: 8, cursor: 'pointer',
          border: active ? '2px solid var(--dsw-alias-brand-primary, #1f6feb)' : '1px solid ' + C.border,
          background: active ? C.bg2 : 'transparent',
        },
      },
      h('div', { style: { color: C.label, fontSize: 13, fontWeight: 600 } }, title),
      h('div', { style: { color: C.sub, fontSize: 11, marginTop: 3, lineHeight: 1.5 } }, desc))
    }

    function lines(list) { return (list || []).join('\n') }
    function parseList(text) {
      return String(text || '').split(/[\n,，、]+/).map(s => s.trim()).filter(Boolean)
    }

    function modeCard(draft, setDraft) {
      const current = draft.frontendMode === 'astrbot' ? 'astrbot' : 'direct'
      const copy = {
        direct: { title: 'DSH 直接接管', desc: 'QQ → NapCat → 本插件。私聊直接说事，不需要前缀。' },
        astrbot: { title: 'AstrBot 桥接', desc: 'QQ → NapCat → AstrBot → 本插件执行。用 !dsh 前缀调用。' },
      }
      const options = Object.keys(copy).map(key => {
        const on = current === key
        return h('div', {
          key,
          onClick: () => setDraft(Object.assign({}, draft, { frontendMode: key })),
          style: {
            flex: 1, cursor: 'pointer', padding: '10px 12px', borderRadius: 8,
            border: '1px solid ' + (on ? 'var(--dsw-alias-brand-primary, #1f6feb)' : C.border),
            background: on ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          },
        },
        h('div', { style: { color: C.label, fontSize: 13, fontWeight: 600 } }, copy[key].title),
        h('div', { style: { color: C.sub, fontSize: 11, marginTop: 4, lineHeight: 1.5 } }, copy[key].desc))
      })
      return h('div', { style: Object.assign({}, box, { marginTop: 12 }) },
        h('div', { style: { color: C.label, fontSize: 14, fontWeight: 600 } }, '接入方式'),
        h('div', { style: { display: 'flex', gap: 10, marginTop: 8 } }, options),
        h('div', { style: { color: C.sub, fontSize: 11, marginTop: 8, lineHeight: 1.5 } },
          '只能选一种。两种同时开会一问两答；切换后保存并重新加载插件生效。'))
    }

    function peerRow(name, info, hint) {
      const up = !!(info && info.up)
      return h('div', {
        key: name,
        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' },
      },
      h('span', {
        style: { width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: up ? C.ok : C.sub },
      }),
      h('span', { style: { color: C.label, fontSize: 12, minWidth: 78 } }, name),
      h('span', { style: { color: C.sub, fontSize: 11, flex: 1 } },
        up ? '已在运行' : ('没检测到' + (hint ? '，' + hint : ''))),
      info && info.url
        ? h('a', {
            href: info.url, target: '_blank', rel: 'noreferrer',
            style: { color: 'var(--dsw-alias-brand-primary, #1f6feb)', fontSize: 12, whiteSpace: 'nowrap' },
          }, '打开设置')
        : null)
    }

    function peersCard(peers, onRefresh, err) {
      return h('div', { style: Object.assign({}, box, { marginTop: 12 }) },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { color: C.label, fontSize: 14, fontWeight: 600 } }, '周边程序'),
          h('span', { style: { color: C.sub, fontSize: 11 } }, '检测本机是否在运行，点右边直接跳过去'),
          h('span', {
            onClick: onRefresh,
            style: { marginLeft: 'auto', color: 'var(--dsw-alias-brand-primary, #1f6feb)', fontSize: 12, cursor: 'pointer' },
          }, '刷新')),
        h('div', { style: { marginTop: 6 } },
          peerRow('NapCat', peers && peers.napcat, '先去启动 NapCat'),
          peerRow('AstrBot', peers && peers.astrbot, '不用 AstrBot 可以忽略')),
        err ? h('div', { style: { color: C.bad, fontSize: 11, marginTop: 4 } }, '检测失败：' + err) : null,
        h('div', { style: { color: C.sub, fontSize: 11, marginTop: 6, lineHeight: 1.5 } },
          '这里只看端口有没有在监听，不代表已经登录 QQ 或已经连到本插件。'))
    }

    function SettingsPage() {
      const [draft, setDraft] = useState(null)
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      const [error, setError] = useState('')
      const [peers, setPeers] = useState(null)
      const [peerErr, setPeerErr] = useState('')

      const loadPeers = useCallback(() => {
        setPeerErr('')
        return api('/peers').then(body => setPeers(body)).catch(e => setPeerErr(String(e && e.message ? e.message : e)))
      }, [])

      useEffect(() => { loadPeers() }, [loadPeers])

      const load = useCallback(() => {
        setNote('')
        return api('/config').then(body => {
          const cfg = body.config || {}
          setDraft(Object.assign({}, cfg, {
            ownersText: lines(cfg.owners),
            extraAllowedText: lines(cfg.extraAllowed),
            sendRootsText: lines(cfg.sendRoots),
          }))
          setStatus(body.status || null)
        }).catch(e => setError(T.loadFailed + (e && e.message ? e.message : e)))
      }, [])

      useEffect(() => { load() }, [load])

      const set = (k, v) => setDraft(d => Object.assign({}, d, { [k]: v }))

      const save = () => {
        if (!draft || busy) return
        setBusy(true); setNote(''); setError('')
        api('/config', {
          method: 'POST',
          body: {
            enabled: !!draft.enabled,
            host: String(draft.host || '127.0.0.1').trim(),
            port: Number(draft.port) || 6700,
            accessToken: String(draft.accessToken || ''),
            owners: parseList(draft.ownersText),
            extraAllowed: parseList(draft.extraAllowedText),
            workspace: String(draft.workspace || '').trim(),
            frontendMode: draft.frontendMode === 'astrbot' ? 'astrbot' : 'direct',
            permissionMode: String(draft.permissionMode || 'standard'),
            allowShell: !!draft.allowShell,
            allowDesktop: !!draft.allowDesktop,
            allowBrowser: !!draft.allowBrowser,
            allowFileSend: !!draft.allowFileSend,
            sendRoots: parseList(draft.sendRootsText),
            approvalForward: !!draft.approvalForward,
            approvalTimeoutSec: Number(draft.approvalTimeoutSec) || 180,
            maxReplyChars: Number(draft.maxReplyChars) || 1800,
            provider: String(draft.provider || '').trim(),
            model: String(draft.model || '').trim(),
            reasoningEffort: String(draft.reasoningEffort || '').trim(),
            systemPromptExtra: String(draft.systemPromptExtra || ''),
            napcatWebui: String(draft.napcatWebui || '').trim(),
            astrbotWebui: String(draft.astrbotWebui || '').trim(),
          },
        }).then(body => setNote(body.applied ? T.saved : T.savedLocal))
          .catch(e => setError(T.failed + (e && e.message ? e.message : e)))
          .then(() => setBusy(false))
      }

      if (!draft) {
        return h('div', { style: { padding: 24, color: C.sub, fontSize: 13 } },
          error ? h('div', { style: { color: C.bad } }, error) : T.loading)
      }

      const st = status || {}
      const connected = !!st.connected
      const wsUrl = 'ws://' + (draft.host || '127.0.0.1') + ':' + (draft.port || 6700) + '/'

      return h('div', { style: { padding: '4px 4px 40px', maxWidth: 760 } },
        h('div', { style: { color: C.label, fontSize: 16, fontWeight: 600 } }, T.title),
        h('div', { style: { color: C.sub, fontSize: 12, marginTop: 4, lineHeight: 1.6 } }, T.sub),
        peersCard(peers, loadPeers, peerErr),
        modeCard(draft, setDraft),

        // 连接状态提示
        h('div', {
          style: {
            marginTop: 10, padding: '9px 12px', borderRadius: 8,
            border: '1px solid ' + (connected ? C.ok : C.border),
            background: connected ? C.bg2 : 'transparent',
            color: C.label, fontSize: 12, lineHeight: 1.6,
          },
        },
        h('span', {
          style: {
            display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 6,
            background: connected ? C.ok : C.warn,
          },
        }),
        connected
          ? 'NapCat 已连接（bot QQ ' + (st.selfId || '未知') + '），现在可以在 QQ 里私聊它了。'
          : h('span', null,
            'NapCat 还没连过来。这是正常的：要先去 NapCat 里填一个反向 WebSocket 地址 ',
            h('code', { style: { background: C.bg2, padding: '1px 5px', borderRadius: 4 } }, wsUrl),
            '（第 1 步有图解链接）。连上这里会变绿。')),

        card(1, '把 QQ 接过来（NapCat）',
          '本插件是「等服务端」：不登录 QQ，由 NapCat 把消息转发过来。装好 NapCat 并登录小号后，在它的「网络配置 → WebSocket 客户端」里添加：',
          h('div', null,
            field('连接地址', 'NapCat 里填这个；token 若填了，本页也要填同一个',
              h('div', {
                style: Object.assign({}, inputStyle, { fontFamily: 'monospace', background: C.bg2 }),
              }, wsUrl)),
            h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' } },
              field('启用监听', '', h('div', null, toggle(!!draft.enabled, v => set('enabled', v), '开启'))),
              field('端口', '默认 6700，被占用再改',
                h('div', { style: { width: 120 } }, input(draft.port, v => set('port', v), { type: 'number' }))),
              field('Access Token', '可留空；填了 NapCat 也要填',
                h('div', { style: { width: 220 } }, input(draft.accessToken, v => set('accessToken', v), {
                  type: 'password', placeholder: draft.hasToken ? '已设置，留空不改' : '可留空',
                })))),
            h('div', { style: { color: C.sub, fontSize: 11, marginTop: 6, lineHeight: 1.6 } },
              'NapCat 文档：', h('a', {
                href: 'https://napneko.github.io/guide/start-install',
                target: '_blank', rel: 'noreferrer',
                style: { color: 'var(--dsw-alias-brand-primary, #1f6feb)' },
              }, 'napneko.github.io'),
              '；如果你同时用 AstrBot：AstrBot 和本插件互不干扰，NapCat 可以同时连两个地方——把其中一个 WebSocket 客户端指向本插件即可。'))),

        card(2, '谁能指挥它',
          '只有下面这些 QQ 号私聊它才有反应，其他人的消息会被忽略。',
          field('主人 QQ 号', '每行一个；只填你自己的号最安全',
            area(draft.ownersText, v => set('ownersText', v), 2))),

        card(3, '它能干什么（权限）',
          '这决定 bot 在你电脑上的手脚范围。改完保存，bot 会话会按新权限重建。',
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 } },
            permCard('safe', draft.permissionMode, v => set('permissionMode', v), '只看不动', '能读文件、能查资料；任何写入、执行命令都会被拒绝。'),
            permCard('standard', draft.permissionMode, v => set('permissionMode', v), '正常工作（推荐）', '能在工作目录里读写文件、执行命令；删文件、装软件这类危险操作会先发到 QQ 问你。'),
            permCard('full', draft.permissionMode, v => set('permissionMode', v), '完全放开', '不受限，也不再问你。只在你完全信任时才用。')),

          field('工作目录', 'bot 默认在这个目录里干活（绝对路径）。留空则用 DSH 当前目录',
            input(draft.workspace, v => set('workspace', v), { placeholder: '例如 D:\\我的项目' })),

          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8, marginTop: 6 } },
            toggle(!!draft.allowShell, v => set('allowShell', v), '执行命令（bash/pwsh）'),
            toggle(!!draft.allowDesktop, v => set('allowDesktop', v), '操作桌面（点击/截图）'),
            toggle(!!draft.allowBrowser, v => set('allowBrowser', v), '使用浏览器'),
            toggle(!!draft.allowFileSend, v => set('allowFileSend', v), '通过 QQ 发文件')),

          h('details', { style: { marginTop: 10 } },
            h('summary', { style: { color: C.sub, fontSize: 12, cursor: 'pointer' } }, '更多选项（一般不用动）'),
            field('额外允许发文件的目录', '每行一个绝对路径；工作目录已默认允许',
              area(draft.sendRootsText, v => set('sendRootsText', v), 2)),
            field('危险操作先问你', '批准方式：QQ 里回 /allow 编号；超时自动拒绝',
              h('div', null, toggle(!!draft.approvalForward, v => set('approvalForward', v), '把审批发到 QQ'))),
            field('审批等待秒数', '', input(draft.approvalTimeoutSec, v => set('approvalTimeoutSec', v), { type: 'number' })),
            field('单条回复最长字数', '超出会拆成多条发送', input(draft.maxReplyChars, v => set('maxReplyChars', v), { type: 'number' }))) ),

        h('details', { style: Object.assign({}, box, { marginTop: 12 }) },
          h('summary', { style: { color: C.label, fontSize: 13, cursor: 'pointer' } }, '高级：模型与提示词'),
          field('Provider / Model', '留空则跟随 DSH 默认模型',
            h('div', { style: { display: 'flex', gap: 8 } },
              h('div', { style: { flex: 1 } }, input(draft.provider, v => set('provider', v), { placeholder: 'provider' })),
              h('div', { style: { flex: 1 } }, input(draft.model, v => set('model', v), { placeholder: 'model' })))),
          field('推理档位', '可留空', input(draft.reasoningEffort, v => set('reasoningEffort', v))),
          field('附加系统提示', '追加给 bot 的说明，可留空',
            area(draft.systemPromptExtra, v => set('systemPromptExtra', v), 3)),
          field('监听地址', '保持 127.0.0.1；改成 0.0.0.0 会暴露到局域网',
            input(draft.host, v => set('host', v)))),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' } },
          h('button', {
            onClick: save, disabled: busy,
            style: {
              padding: '8px 20px', borderRadius: 7, border: 'none', cursor: busy ? 'default' : 'pointer',
              background: 'var(--dsw-alias-brand-primary, #1f6feb)', color: '#fff', fontSize: 13,
            },
          }, busy ? T.saving : T.save),
          h('button', {
            onClick: load,
            style: {
              padding: '8px 14px', borderRadius: 7, cursor: 'pointer', fontSize: 13,
              border: '1px solid ' + C.border, background: C.bg, color: C.label,
            },
          }, T.reload),
          note ? h('span', { style: { color: C.ok, fontSize: 12 } }, note) : null,
          error ? h('span', { style: { color: C.bad, fontSize: 12 } }, error) : null))
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'qqbot',
        order: 41,
        label: () => T.nav,
      }, () => h(SettingsPage)))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = '@local/dsh-qqbot'
    return module.exports
  },
})
