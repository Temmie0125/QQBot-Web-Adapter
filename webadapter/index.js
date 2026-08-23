/**
 * QQBot-Web-Adapter 自身扩展操作模块
 * 遵循与其他插件相同的 webadapter/index.js 约定，由框架自动扫描并调用 init(ctx)
 */

import * as menuPanel from "../../QQBot-Plugin/lib/menuPanel.js"
import fs from "node:fs"
import path from "node:path"

export function init(ctx) {
  // ====== 页面注册 ======

  // 原 webadapter/page.js 的约定式注册 → 改为 init(ctx) 中编程式注册
  ctx.registerPage({
    id: "web-page-guide",
    title: "自定义页面写法",
    icon: "📝",
    priority: 100,
    src: "page.html",
    style: "page.css",
  })

  // Redis 键值浏览页
  ctx.registerPage({
    id: "web-redis-viewer",
    title: "Redis 查看",
    icon: "📦",
    priority: 99,
    src: "redis.html",
  })

  // ====== API 注册 ======

  /**
   * GET /web-redis — 浏览 Redis 键值对
   * ?pattern=*&cursor=0  扫描匹配的键列表
   * ?key=xxx             查看指定键的完整值
   */
  ctx.registerApi("get", "/web-redis", async (_req, res) => {
    try {
      if (typeof redis === "undefined" || !redis) {
        return res.json({ ok: false, error: "Redis 未连接" })
      }

      const params = new URLSearchParams((_req.url || "").split("?")[1] || "")
      const targetKey = params.get("key")

      if (targetKey) {
        // 查看单个键
        const type = await redis.type(targetKey)
        const ttl = await redis.ttl(targetKey)
        let value

        switch (type) {
          case "string": {
            const raw = await redis.get(targetKey)
            try { value = JSON.parse(raw) } catch { value = raw }
            break
          }
          case "hash":
            value = await redis.hGetAll(targetKey)
            break
          case "list":
            value = await redis.lRange(targetKey, 0, -1)
            break
          case "set":
            value = await redis.sMembers(targetKey)
            break
          case "zset":
            value = await redis.zRange(targetKey, 0, -1, "WITHSCORES")
            break
          default:
            value = null
        }

        return res.json({ ok: true, key: targetKey, type, ttl, value })
      }

      // 扫描键列表
      const pattern = params.get("pattern") || "*"
      const cursor = parseInt(params.get("cursor")) || 0
      const count = Math.min(100, Math.max(10, parseInt(params.get("count")) || 50))

      const reply = await redis.scan(cursor, { MATCH: pattern, COUNT: count })
      const nextCursor = reply.cursor
      const keys = reply.keys

      const list = []
      if (keys && keys.length > 0) {
        const multi = redis.multi()
        for (const k of keys) { multi.type(k); multi.ttl(k) }
        const results = await multi.exec()
        // multi().exec() 返回扁平数组 [type1, ttl1, type2, ttl2, ...]
        for (let i = 0; i < keys.length; i++) {
          list.push({
            key: keys[i],
            type: results[i * 2] || "none",
            ttl: results[i * 2 + 1] ?? -2,
          })
        }
      }

      res.json({ ok: true, cursor: nextCursor, pattern, keys: list, hasMore: String(nextCursor) !== "0" })
    } catch (e) {
      res.json({ ok: false, error: e.message })
    }
  })

  /**
   * DELETE /web-redis — 删除 Redis 键
   * ?key=xxx     删除单个键
   * ?pattern=xxx 删除匹配模式的所有键
   */
  ctx.registerApi("delete", "/web-redis", async (_req, res) => {
    try {
      if (typeof redis === "undefined" || !redis) {
        return res.json({ ok: false, error: "Redis 未连接" })
      }

      const params = new URLSearchParams((_req.url || "").split("?")[1] || "")
      const targetKey = params.get("key")
      const pattern = params.get("pattern")

      // 单个键删除
      if (targetKey) {
        const deleted = await redis.del(targetKey)
        return res.json({ ok: true, key: targetKey, deleted })
      }

      // 按 pattern 批量删除
      if (pattern) {
        let cursor = 0
        let total = 0
        do {
          const reply = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 })
          cursor = reply.cursor
          if (reply.keys && reply.keys.length > 0) {
            const multi = redis.multi()
            for (const k of reply.keys) multi.del(k)
            const results = await multi.exec()
            total += results.filter(r => r).length
          }
        } while (String(cursor) !== "0")
        return res.json({ ok: true, pattern, deleted: total })
      }

      res.json({ ok: false, error: "请提供 key 或 pattern 参数" })
    } catch (e) {
      res.json({ ok: false, error: e.message })
    }
  })

  // ====== 自定义菜单与指令面板 ======

  // 注册管理页面（iframe 嵌入 webadapter/menuPanel.html）
  ctx.registerPage({
    id: "qqbot-menu-panel",
    title: "菜单与面板",
    icon: "🎛️",
    priority: 90,
    src: "menuPanel.html",
    assetsDir: "public", // 资源目录：webadapter/public/ 下文件均可经 /api/web-page/<plugin>/public/ 访问
  })

  // 沙盒模拟页（纯前端模拟 QQBot 事件，可切换真实 Bot 发送）
  ctx.registerPage({
    id: "qqbot-sandbox",
    title: "沙盒模拟",
    icon: "🧪",
    priority: 80,
    src: "sandbox.html",
    assetsDir: "public",
  })

  // 当前选中的 Bot 由主页面 selectBot 上报并存于进程内存，接口直接读取，前端无需传递 selfId
  const selfIdOf = () => Bot.webAdapter.getSelectedSelfId()

  // ====== 菜单 / 面板备份（本地 JSON，目录 data/menu、data/panel）======
  const BK_DIR = path.join(ctx.pluginDir, "data")
  const BK_MENU_DIR = path.join(BK_DIR, "menu")
  const BK_PANEL_DIR = path.join(BK_DIR, "panel")
  const BK_CFG_FILE = path.join(BK_DIR, "backup-config.json")
  const BK_LIMIT = 50 // 每类最多保留 50 条，超出删除最旧
  const BK_KINDS = new Set(["menu", "panel"]) // 备份类型白名单
  // 备份文件名白名单：首字符为字母/数字，仅含 [A-Za-z0-9_.-]，必须以 .json 结尾，总长 ≤ 80
  // 天然排除路径分隔符（/ \）、盘符冒号、.. 前缀等，杜绝目录穿越
  const BK_FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,71}\.json$/
  const BK_MAX_BYTES = 1024 * 1024 // 单条备份读取上限 1MB，防止超大文件拖垮接口

  function bkEnsureDir(p) { try { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }) } catch { /* 忽略 */ } }
  const bkDirOf = (kind) => kind === "menu" ? BK_MENU_DIR : BK_PANEL_DIR
  // 安全解析备份文件绝对路径：类型白名单 + 文件名白名单 + 目录内校验 + 符号链接逃逸校验
  // 返回安全的绝对路径；任一步不通过返回 null（文件不存在时仅做路径合法性校验，供删除区分"不存在"）
  function bkSafeResolve(kind, file) {
    if (!BK_KINDS.has(kind)) return null
    if (typeof file !== "string" || !BK_FILE_RE.test(file)) return null
    const dir = bkDirOf(kind)
    const abs = path.resolve(dir, file)
    // 兜底一：拼接结果必须位于基准目录内（防白名单以外的编码绕过）
    const rel = path.relative(dir, abs)
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null
    // 兜底二：真实路径（解析符号链接后）也必须在基准目录内，防止软链指向目录外文件
    try {
      const realDir = fs.realpathSync(dir)
      if (fs.existsSync(abs)) {
        const real = fs.realpathSync(abs)
        const rrel = path.relative(realDir, real)
        if (rrel.startsWith("..") || path.isAbsolute(rrel)) return null
      }
    } catch { return null }
    return abs
  }

  function bkReadCfg() {
    try { return JSON.parse(fs.readFileSync(BK_CFG_FILE, "utf8")) || {} } catch { return {} }
  }
  function bkWriteCfg(cfg) {
    try { bkEnsureDir(BK_DIR); fs.writeFileSync(BK_CFG_FILE, JSON.stringify(cfg, null, 2)) } catch { /* 忽略 */ }
  }
  const bkEnabled = (kind) => { const c = bkReadCfg(); return kind === "menu" ? !!c.menuEnabled : !!c.panelEnabled }
  function bkTimeStr() {
    const d = new Date(), p = n => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  // 写备份：开关开启时把快照写入 JSON 文件，自动清理超出上限的旧备份（清理仅限白名单文件，软链不跟随）
  function bkWrite(kind, data) {
    try {
      if (!BK_KINDS.has(kind) || !bkEnabled(kind)) return
      const dir = bkDirOf(kind); bkEnsureDir(dir)
      const file = `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`
      fs.writeFileSync(path.join(dir, file), JSON.stringify({ type: kind, time: bkTimeStr(), data }, null, 2))
      const files = fs.readdirSync(dir).filter(f => BK_FILE_RE.test(f)).sort()
      while (files.length > BK_LIMIT) { const old = files.shift(); try { fs.unlinkSync(path.join(dir, old)) } catch { /* 忽略 */ } }
    } catch (e) { ctx.logger?.error?.(`[QQBot-Web] ${kind} 备份写入失败:`, e) }
  }
  // 备份列表：每项含文件名、时间、内容摘要；仅读取文件头部解析，不加载整个文件
  function bkList(kind) {
    if (!BK_KINDS.has(kind)) return []
    const dir = bkDirOf(kind); bkEnsureDir(dir)
    let files = []
    try { files = fs.readdirSync(dir) } catch { return [] }
    return files.filter(f => BK_FILE_RE.test(f)).sort().reverse().map(f => {
      const meta = { file: f }
      try {
        const fp = path.join(dir, f)
        const size = fs.statSync(fp).size
        if (size <= 0 || size > BK_MAX_BYTES) return meta
        const head = Buffer.alloc(Math.min(size, 64 * 1024))
        const fd = fs.openSync(fp, "r")
        try { fs.readSync(fd, head, 0, head.length, 0) } finally { fs.closeSync(fd) }
        const j = JSON.parse(head.toString("utf8"))
        meta.time = j.time || ""
        const d = j.data || {}
        if (kind === "menu") meta.itemCount = (d.menu?.items || []).length
        else { meta.itemCount = (d.panel?.items || d.panel?.buttons || []).length; meta.scope = d.scope || "" }
      } catch { /* 单个损坏忽略 */ }
      return meta
    })
  }
  // 读单条备份（data 字段）：安全路径解析 + 文件大小限制
  function bkRead(kind, file) {
    const fp = bkSafeResolve(kind, file)
    if (!fp) return null
    try {
      if (fs.statSync(fp).size > BK_MAX_BYTES) return null
      return JSON.parse(fs.readFileSync(fp, "utf8"))
    } catch { return null }
  }
  // 删除单条备份：安全路径解析（不存在时也能区分并返回"备份不存在"）
  function bkDelete(kind, file) {
    const fp = bkSafeResolve(kind, file)
    if (!fp) return { ok: false, error: "非法文件名" }
    try {
      if (!fs.existsSync(fp)) return { ok: false, error: "备份不存在" }
      fs.unlinkSync(fp); return { ok: true }
    } catch (e) { return { ok: false, error: String(e?.message || e) } }
  }

  // 备份开关配置 GET/PUT /menu-panel/backup/config
  Bot.webAdapter.registerApi("get", "/menu-panel/backup/config", (_req, res) => {
    const c = bkReadCfg()
    res.json({ ok: true, data: { menuEnabled: !!c.menuEnabled, panelEnabled: !!c.panelEnabled } })
  })
  Bot.webAdapter.registerApi("put", "/menu-panel/backup/config", (req, res) => {
    const b = req.body || {}
    bkWriteCfg({ menuEnabled: !!b.menuEnabled, panelEnabled: !!b.panelEnabled })
    res.json({ ok: true, data: { menuEnabled: !!b.menuEnabled, panelEnabled: !!b.panelEnabled } })
  })

  // 菜单备份：列表 / 详情 / 删除
  Bot.webAdapter.registerApi("get", "/menu-panel/backup/menu", (_req, res) => {
    res.json({ ok: true, data: bkList("menu") })
  })
  Bot.webAdapter.registerApi("get", "/menu-panel/backup/menu/:file", (req, res) => {
    const bk = bkRead("menu", req.params.file)
    if (!bk) return res.json({ ok: false, error: "备份不存在或已损坏" })
    res.json({ ok: true, data: bk.data, time: bk.time || "", file: req.params.file })
  })
  Bot.webAdapter.registerApi("delete", "/menu-panel/backup/menu/:file", (req, res) => {
    res.json(bkDelete("menu", req.params.file))
  })

  // 面板备份：列表 / 详情 / 删除
  Bot.webAdapter.registerApi("get", "/menu-panel/backup/panel", (_req, res) => {
    res.json({ ok: true, data: bkList("panel") })
  })
  Bot.webAdapter.registerApi("get", "/menu-panel/backup/panel/:file", (req, res) => {
    const bk = bkRead("panel", req.params.file)
    if (!bk) return res.json({ ok: false, error: "备份不存在或已损坏" })
    res.json({ ok: true, data: bk.data, time: bk.time || "", file: req.params.file })
  })
  Bot.webAdapter.registerApi("delete", "/menu-panel/backup/panel/:file", (req, res) => {
    res.json(bkDelete("panel", req.params.file))
  })

  // 查询全局自定义菜单 GET /menu-panel/menu
  Bot.webAdapter.registerApi("get", "/menu-panel/menu", async (_req, res) => {
    res.json(await menuPanel.getMenu(selfIdOf()))
  })

  // 修改全局自定义菜单 PUT /menu-panel/menu  body: { menu }
  Bot.webAdapter.registerApi("put", "/menu-panel/menu", async (req, res) => {
    const r = await menuPanel.changeMenu(req.body?.menu, selfIdOf())
    if (r.ok) bkWrite("menu", { menu: req.body?.menu || {} })
    res.json(r)
  })

  // 查询指令面板列表 GET /menu-panel/panels?scope=group
  Bot.webAdapter.registerApi("get", "/menu-panel/panels", async (req, res) => {
    const scope = new URLSearchParams((req.url || "").split("?")[1] || "").get("scope") || "group"
    res.json(await menuPanel.getPanels(scope, selfIdOf()))
  })

  // 创建指令面板 POST /menu-panel/panels
  // body: { scope, target_type, user_openids, group_openids, panel }
  Bot.webAdapter.registerApi("post", "/menu-panel/panels", async (req, res) => {
    const b = req.body || {}
    const r = await menuPanel.createPanels(
      b.scope, b.target_type, b.user_openids || [], b.group_openids || [], b.panel, selfIdOf()
    )
    if (r.ok) {
      bkWrite("panel", {
        scope: b.scope, target_type: b.target_type || "all",
        user_openids: b.user_openids || [], group_openids: b.group_openids || [],
        panel: b.panel || {},
      })
    }
    res.json(r)
  })

  // 查询指令面板详情 GET /menu-panel/panels/:id
  Bot.webAdapter.registerApi("get", "/menu-panel/panels/:id", async (req, res) => {
    res.json(await menuPanel.getPanel(req.params.id, selfIdOf()))
  })

  // 修改指令面板 PUT /menu-panel/panels/:id  body: { panel }
  Bot.webAdapter.registerApi("put", "/menu-panel/panels/:id", async (req, res) => {
    const r = await menuPanel.changePanel(req.params.id, req.body?.panel, selfIdOf())
    if (r.ok) {
      // 修改接口只传 panel 内容，需再查详情补齐 scope / target_type / openids 后备份
      const detail = await menuPanel.getPanel(req.params.id, selfIdOf())
      const d = detail?.ok && detail.data ? detail.data : {}
      bkWrite("panel", {
        scope: d.scope || "group", target_type: d.target_type || "all",
        user_openids: d.user_openids || [], group_openids: d.group_openids || [],
        panel: req.body?.panel || {},
      })
    }
    res.json(r)
  })

  // 删除指令面板 DELETE /menu-panel/panels/:id
  Bot.webAdapter.registerApi("delete", "/menu-panel/panels/:id", async (req, res) => {
    // 删除前先取详情，删成功后备一份，便于误删恢复
    const detail = await menuPanel.getPanel(req.params.id, selfIdOf())
    const r = await menuPanel.deletePanel(req.params.id, selfIdOf())
    if (r.ok) {
      const d = detail?.ok && detail.data ? detail.data : {}
      if (d.panel) {
        bkWrite("panel", {
          scope: d.scope || "group", target_type: d.target_type || "all",
          user_openids: d.user_openids || [], group_openids: d.group_openids || [],
          panel: d.panel,
        })
      }
    }
    res.json(r)
  })

  // 修改指令面板关联对象 PUT /menu-panel/panels/:id/target
  // body: { op, user_openids, group_openids }
  Bot.webAdapter.registerApi("put", "/menu-panel/panels/:id/target", async (req, res) => {
    const b = req.body || {}
    res.json(await menuPanel.changePanelTarget(
      req.params.id, b.op, b.user_openids || [], b.group_openids || [], selfIdOf()
    ))
  })

  // 解析 openid → 用户/群展示信息（供面板关联对象选择器使用）
  // GET /menu-panel/resolve-openid?openid=u_xxx&kind=user|group
  Bot.webAdapter.registerApi("get", "/menu-panel/resolve-openid", async (req, res) => {
    try {
      const selfId = selfIdOf()
      const bot = selfId ? Bot[selfId] : null
      const params = new URLSearchParams((req.url || "").split("?")[1] || "")
      const openid = (params.get("openid") || "").trim()
      const kind = params.get("kind") === "group" ? "group" : "user"
      if (!bot || !bot.adapter || !openid) return res.json({ ok: true, found: false, openid })
      // fl/gl 的 key 为 "selfId<sep>openid"，同时兼容纯 openid 兜底
      const fullKey = `${selfId}${bot.adapter.sep}${openid}`
      if (kind === "user") {
        const info = bot.fl && bot.fl.get
          ? (bot.fl.get(fullKey) || bot.fl.get(openid))
          : null
        if (info && (info.nickname || info.avatar)) {
          return res.json({ ok: true, found: true, openid, nickname: info.nickname || "", avatar: info.avatar || "" })
        }
        return res.json({ ok: true, found: false, openid })
      }
      // group
      let info = bot.gl && bot.gl.get
        ? (bot.gl.get(fullKey) || bot.gl.get(openid))
        : null
      if (!info || !(info.group_name || info.nickname)) {
        const sdk = bot.sdk || bot
        const pureId = openid.startsWith("g_") ? openid.slice(2) : openid
        try {
          if (sdk && typeof sdk.getGroupInfo === "function") {
            const gi = await sdk.getGroupInfo(pureId)
            if (gi) info = gi
          }
        } catch (e) { /* 忽略：缓存优先 */ }
      }
      if (info && (info.group_name || info.nickname)) {
        return res.json({ ok: true, found: true, openid, nickname: info.group_name || info.nickname || "", avatar: info.avatar || "" })
      }
      return res.json({ ok: true, found: false, openid })
    } catch (e) {
      return res.json({ ok: false, error: String((e && e.message) ? e.message : e) })
    }
  })
}
