/**
 * QQBot-Web-Adapter 自身扩展操作模块
 * 遵循与其他插件相同的 webadapter/index.js 约定，由框架自动扫描并调用 init(ctx)
 */

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
}
