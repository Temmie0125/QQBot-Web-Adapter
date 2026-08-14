/**
 * QQBot-Web-Adapter 自身扩展操作模块
 * 遵循与其他插件相同的 webadapter/index.js 约定，由框架自动扫描并调用 init(ctx)
 */

import * as menuPanel from "../../QQBot-Plugin/lib/menuPanel.js"

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

  // 当前选中的 Bot 由主页面 selectBot 上报并存于进程内存，接口直接读取，前端无需传递 selfId
  const selfIdOf = () => Bot.webAdapter.getSelectedSelfId()

  // 查询全局自定义菜单 GET /menu-panel/menu
  Bot.webAdapter.registerApi("get", "/menu-panel/menu", async (_req, res) => {
    res.json(await menuPanel.getMenu(selfIdOf()))
  })

  // 修改全局自定义菜单 PUT /menu-panel/menu  body: { menu }
  Bot.webAdapter.registerApi("put", "/menu-panel/menu", async (req, res) => {
    res.json(await menuPanel.changeMenu(req.body?.menu, selfIdOf()))
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
    res.json(await menuPanel.createPanels(
      b.scope, b.target_type, b.user_openids || [], b.group_openids || [], b.panel, selfIdOf()
    ))
  })

  // 查询指令面板详情 GET /menu-panel/panels/:id
  Bot.webAdapter.registerApi("get", "/menu-panel/panels/:id", async (req, res) => {
    res.json(await menuPanel.getPanel(req.params.id, selfIdOf()))
  })

  // 修改指令面板 PUT /menu-panel/panels/:id  body: { panel }
  Bot.webAdapter.registerApi("put", "/menu-panel/panels/:id", async (req, res) => {
    res.json(await menuPanel.changePanel(req.params.id, req.body?.panel, selfIdOf()))
  })

  // 删除指令面板 DELETE /menu-panel/panels/:id
  Bot.webAdapter.registerApi("delete", "/menu-panel/panels/:id", async (req, res) => {
    res.json(await menuPanel.deletePanel(req.params.id, selfIdOf()))
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
