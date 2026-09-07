import YAML from "yaml"
import path from "node:path"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import os from "node:os"
import crypto from "node:crypto"
import { execSync, exec as execCb } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from "node:module"
import express from "express"
import { isGroupBlacklisted, isUserBlacklisted, blacklistGroup as blGroup, unblacklistGroup as unblGroup, blacklistUser as blUser, unblacklistUser as unblUser, getBlacklistData } from "../QQBot-Plugin/lib/blacklist.js"
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 尝试加载 qrcode 包（QQBot-Plugin 已依赖）
let QRCode
try { QRCode = (await import("qrcode")).default } catch { QRCode = null }

// IP 归属地：ip-geo-cn（纯真，IPv4 中国省市最优）+ geoip-lite（IPv6 兜底）
let qqwry, geoip
try { qqwry = new (createRequire(import.meta.url)("ip-geo-cn"))() } catch { qqwry = null }
try { geoip = (await import("geoip-lite")).default } catch { geoip = null }

// WebAdapter 自身版本
const WEB_ADAPTER_VERSION = "1.0.2"

// 加载沙盒 adapter（同 plugins/adapter/stdin.js 思路：注册一个虚拟 adapter 进 Bot.adapter）
// 沙盒页面发送用户消息/通知会触发插件，插件回复以 qqbot_msg 事件回流到页面显示
try { await import("./sandbox.js") } catch (e) { logger.error(`[QQBot-Web] 沙盒 adapter 加载失败: ${e.message}`) }

// ========== 自定义配置加载（config.yaml 位于插件目录下） ==========
const CONFIG_DIR = path.join(__dirname, "config")
const CONFIG_FILE = path.join(CONFIG_DIR, "config.yaml")

const DEFAULT_CONFIG = {
  basePath: "qqbot-web",
  autoRecordMessage: true,
  autoDownloadImgorVideo: true,
  maxMediaCacheSize: 10,
  saveTimes: 3,
  storageBackend: "redis",
  login: {
    enabled: true,
    username: "admin",
    password: "admin123",
  },
  notifyUserId: "",
  enableQuanliangCommands: true,
  httpLogSilent: false,
  publicAccess: true,
}

let config = { ...DEFAULT_CONFIG }

async function loadConfig() {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true })
  } catch {}
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8")
    const data = YAML.parse(raw)
    if (data && typeof data === "object") {
      // 深度合并：嵌套对象递归覆盖，但不覆盖 DEFAULT 中存在的 key
      config = { ...DEFAULT_CONFIG, ...data }
      if (data.login) config.login = { ...DEFAULT_CONFIG.login, ...data.login }
    }
  } catch {
    logger.debug(`[QQBot-Web] 配置文件 ${CONFIG_FILE} 不存在或读取失败，使用默认配置`)
  }
  // 将配置同步到 Bot 全局（供 adapter 使用）
  // 明确写为 true，以便 adapter 侧用 === true 判断（区分 undefined / 未安装场景）
  Bot.autoRecordMessage = config.autoRecordMessage !== false
  Bot.autoDownloadImgorVideo = config.autoDownloadImgorVideo !== false
  Bot.saveTimes = [1, 2, 3, 4, 5, 6, 7].includes(config.saveTimes) ? config.saveTimes : 3
  Bot.notifyUserId = typeof config.notifyUserId === "string" ? config.notifyUserId : ""
  Bot.storageBackend = config.storageBackend === "sqlite" ? "sqlite" : "redis"
  const mcs = Number(config.maxMediaCacheSize)
  Bot.maxMediaCacheSize = (Number.isFinite(mcs) && mcs >= 1 && mcs <= 100) ? Math.floor(mcs) : 10

  // 控制 HTTP 请求日志静默：开启后不显示 Web Adapter 请求 + well-known 的日志
  if (config.httpLogSilent === true) {
    for (const p of [`/${config.basePath}`, '/.well-known']) {
      if (!Bot.express.quiet.includes(p)) Bot.express.quiet.push(p)
    }
  }

  // 全量群 Map 初始化（仅首次插件加载时创建，后续重启不丢失 .quanliangMap 引用）
  if (!Bot.quanliangMap) {
    Bot.quanliangMap = new Map()
    // 从 Redis 恢复全量群数据
    try {
      const keys = await redis.keys('wind-quanliang:*')
      for (const key of keys) {
        const selfId = key.split(':')[1]
        const groups = await redis.sMembers(key)
        Bot.quanliangMap.set(selfId, new Set(groups))
      }
    } catch {}
  }

  // 写出完整配置（包含默认值中未在文件中的 key）
  try {
    const existing = {}
    try {
      const raw = await fs.readFile(CONFIG_FILE, "utf8")
      Object.assign(existing, YAML.parse(raw) || {})
    } catch {}
    const merged = { ...config }
    // 保留用户注释 tips
    if (existing.tips) merged.tips = existing.tips
    await fs.writeFile(CONFIG_FILE, YAML.stringify(merged), "utf8")
  } catch {}
}

async function configSave() {
  try {
    await fs.writeFile(CONFIG_FILE, YAML.stringify(config), "utf8")
  } catch {}
}

// ========== 置顶数据多后端存储（redis / sqlite） ==========
const PIN_KEY_PREFIX = "wind-pin:"

function pinKey(selfId, kind) {
  return `${PIN_KEY_PREFIX}${selfId}:${kind}`
}

// 当前实际使用的后端：sqlite 且 Bot.PinDB 可用时走 SQLite，否则走 Redis
function currentPinBackend() {
  return config.storageBackend === "sqlite" && Bot.PinDB ? "sqlite" : "redis"
}

async function readPinKey(backend, key) {
  if (backend === "sqlite" && Bot.PinDB) {
    return Bot.PinDB.getByKey(key)
  }
  const raw = await redis.get(key)
  return raw ? JSON.parse(raw) : null
}

async function writePinKey(backend, key, value) {
  const str = JSON.stringify(value)
  if (backend === "sqlite" && Bot.PinDB) {
    await Bot.PinDB.setByKey(key, value)
    return
  }
  await redis.set(key, str)
}

async function getPins(selfId, kind) {
  const v = await readPinKey(currentPinBackend(), pinKey(selfId, kind))
  return Array.isArray(v) ? v : []
}

async function setPins(selfId, kind, arr) {
  await writePinKey(currentPinBackend(), pinKey(selfId, kind), arr)
}

// 从 fromBackend 读取全部置顶键，写入 toBackend（用于切换后端时迁移）
async function migratePins(fromBackend, toBackend) {
  if (fromBackend === toBackend) return
  let keys = []
  if (fromBackend === "sqlite" && Bot.PinDB) {
    keys = await Bot.PinDB.getAllPinKeys()
  } else {
    keys = await redis.keys(`${PIN_KEY_PREFIX}*`)
  }
  // 仅处理以本插件前缀开头的键，避免误迁
  const target = keys.filter(k => k.startsWith(PIN_KEY_PREFIX))
  for (const key of target) {
    const v = await readPinKey(fromBackend, key)
    if (v !== null) await writePinKey(toBackend, key, v)
  }
}

// 加载配置
await loadConfig()

logger.info("-------------------------")
logger.info(logger.green("QQBot-Web-Adapter 配置已加载"))
if (Bot.quanliangMap?.size) {
  logger.info(logger.green(`[QQBot-Web] 已从 Redis 加载 ${Bot.quanliangMap.size} 个机器人的全量群`))
}

// QQBot-Plugin 数据目录（用于本地文件→Buffer，绕开 HTTP 鉴权）
const QQBT_PLUGIN_DIR = path.join(__dirname, "..", "QQBot-Plugin")
const QQBT_DATA_IMGS_DIR = path.join(QQBT_PLUGIN_DIR, "data", "imgs")
const QQBT_DATA_EMOJI_DIR = path.join(QQBT_PLUGIN_DIR, "data", "emoji")

/**
 * 将本地路径/本地 URL 读成 Buffer，避免 SDK HTTP 下载触发鉴权
 * 仅允许 data/imgs/ 目录下的文件
 * @param {string} file - 相对路径 或 local-media URL
 * @returns {{ buf: Buffer, name: string } | null}
 */
async function resolveLocalFile(file) {
  let relPath = file
  // local-media URL → 还原真实路径
  if (file.includes("/local-media?path=")) {
    const m = file.match(/[?&]path=([^&]+)/)
    if (m) relPath = decodeURIComponent(m[1])
  }
  const absPath = path.resolve(QQBT_PLUGIN_DIR, relPath)
  // 安全：仅允许 data/imgs/ 与 data/emoji/ 目录（表情图片本地直发，不经图床）
  const allowed = [QQBT_DATA_IMGS_DIR + path.sep, QQBT_DATA_EMOJI_DIR + path.sep]
  if (!allowed.some(p => absPath.startsWith(p))) return null
  try {
    const buf = await fs.readFile(absPath)
    return { buf, name: path.basename(absPath) }
  } catch {
    return null
  }
}

const WEB_BASE_PREFIX = config.basePath || "qqbot-web"
const WEB_BASE = `/${WEB_BASE_PREFIX}`
const WS_PATH = `${WEB_BASE_PREFIX}-ws`
// 暴露 basePath 给沙盒 adapter（sandbox.js 独立模块，无法直接引用本处变量），
// 用于构造 Bot[沙盒id].avatar 的绝对本地路径（如 /qqbot-web/public/bot.png）。
Bot.qqbotWebBasePath = WEB_BASE

// ========== 兼容 Yunzai 全局鉴权（config/config/server.yaml） ==========
// 一旦在 server.yaml 里配置了 server.auth，Yunzai 会在 Bot.express 最前面挂 serverAuth，
// 本站的页面与 /api/* 接口将全部被它 401 拦截（浏览器无法自动携带自定义 header）。
// 本站自身已带「登录 + 公网访问控制」鉴权（apiAuthGuard），因此把本站前缀加入
// Bot.express.skip_auth 白名单，跳过 Yunzai 全局鉴权，改由本站自己校验。
// 注意：WebSocket 升级握手由 Yunzai bot.js 全局处理（不经 express，此处 skip_auth 对 ws 不生效），
//       其鉴权参数由下方 /api/ws-auth 接口下发给前端拼接在 ws 地址中。
if (Bot.express && Array.isArray(Bot.express.skip_auth) && !Bot.express.skip_auth.includes(WEB_BASE)) {
  Bot.express.skip_auth.push(WEB_BASE)
}

// ========== 自定义页面（开发者扩展 Web 控制台页面） ==========
// 两种注册方式：
//   1) 约定式：扫描 plugins/<插件>/webadapter/page.{js,json}（导出单个或数组描述符）
//   2) 编程式：Bot.webAdapter.registerPage(pluginName, descriptor)
// 描述符字段：
//   { id, title, icon, html?|src?, script?, style? }
//   - src ：指向 webadapter/ 下的 HTML 文件，以 iframe 嵌入
//   - html ：直接注入的 HTML 片段（简单静态页）
//   - script/style ：webadapter/ 下的 js/css（注入时按需加载）
const pluginsRoot = path.dirname(QQBT_PLUGIN_DIR)
const webPages = new Map()
// 每个插件声明过可被 /api/web-page 访问的文件相对路径白名单（按 plugin 分组）
const webPageAllowed = new Map()
// 每个插件声明的「资源目录」（目录名，如 "public"）：该目录内任意文件均可访问
const webPageAssets = new Map()
// 已初始化的「操作模块」路径，避免 login / plugins/loaded 重复扫描时重复初始化
const webInited = new Set()

function _normalizePage(pluginName, def) {
  if (!def || typeof def !== "object") return null
  const id = String(def.id || "").trim()
  const title = String(def.title || "").trim()
  if (!id || !title) return null
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null
  const plugin = pluginName || def.plugin || "external"
  let type, src = null, html = null
  if (def.src) {
    type = "iframe"
    src = `${WEB_BASE}/api/web-page/${encodeURIComponent(plugin)}/${String(def.src).replace(/^\/+/, "")}`
  } else {
    type = "html"
    html = typeof def.html === "string" ? def.html : ""
  }
  const asset = (f) => (f ? `${WEB_BASE}/api/web-page/${encodeURIComponent(plugin)}/${String(f).replace(/^\/+/, "")}` : null)
  // 资源目录：字符串或数组，仅保留合法目录名（禁止穿越）
  const assetsRaw = def.assetsDir == null ? [] : (Array.isArray(def.assetsDir) ? def.assetsDir : [def.assetsDir])
  const assetsDirs = assetsRaw.map(s => String(s).trim()).filter(s => /^[A-Za-z0-9_-]+$/.test(s))
  // 排序优先级：数值越小越靠前（与插件加载 priority 约定一致）；未设置默认为 100
  const priority = Number.isFinite(def.priority) ? def.priority : 100
  return {
    id, title, icon: def.icon || "📄", plugin, type, priority,
    src, html,
    style: asset(def.style),
    script: asset(def.script),
    assetsDirs,
  }
}

function registerWebPage(pluginName, def) {
  const p = _normalizePage(pluginName, def)
  if (!p) return false
  if (webPages.has(p.id)) logger.warn(`[QQBot-Web] 自定义页面 id 冲突，已覆盖: ${p.id}`)
  webPages.set(p.id, p)
  // 收集该插件声明过可被 web-page 接口访问的文件相对路径（src/style/script）
  const plugin = p.plugin
  if (plugin) {
    if (!webPageAllowed.has(plugin)) webPageAllowed.set(plugin, new Set())
    const set = webPageAllowed.get(plugin)
    for (const f of [def.src, def.style, def.script]) {
      if (f) set.add(String(f).replace(/^\/+/, ""))
    }
    // 收集资源目录（整体放行其下所有文件）
    if (p.assetsDirs.length) {
      if (!webPageAssets.has(plugin)) webPageAssets.set(plugin, new Set())
      const aset = webPageAssets.get(plugin)
      for (const d of p.assetsDirs) aset.add(d)
    }
  }
  return true
}

async function scanWebPages() {
  try {
    const dirs = fsSync.readdirSync(pluginsRoot, { withFileTypes: true })
    for (const ent of dirs) {
      if (!ent.isDirectory()) continue
      const wd = path.join(pluginsRoot, ent.name, "webadapter")

      // 1) 约定式页面注册：plugins/<插件>/webadapter/page.{js,json}
      for (const fname of ["page.js", "page.json", "pages.js", "pages.json"]) {
        const fp = path.join(wd, fname)
        if (!fsSync.existsSync(fp)) continue
        try {
          let mod = fname.endsWith(".json")
            ? JSON.parse(fsSync.readFileSync(fp, "utf8"))
            : (await import(pathToFileURL(fp).href)).default
          const list = Array.isArray(mod) ? mod
            : (mod && mod.pages) ? (Array.isArray(mod.pages) ? mod.pages : [mod.pages])
              : mod
          ;(Array.isArray(list) ? list : [list]).forEach(d => registerWebPage(ent.name, d))
        } catch (e) {
          logger.error(`[QQBot-Web] 加载自定义页面失败 ${fp}:`, e.message)
        }
      }

      // 2) 约定式操作模块：plugins/<插件>/webadapter/index.js
      //    统一由 WebAdapter 负责初始化（页面注册 + API / 操作），
      //    插件主入口 index.js 无需任何改动，只需提供该文件即可。
      const opPath = path.join(wd, "index.js")
      if (!webInited.has(opPath) && fsSync.existsSync(opPath)) {
        try {
          const opMod = await import(pathToFileURL(opPath).href)
          const initFn = opMod.init || opMod.default
          if (typeof initFn === "function") {
            initFn({
              basePath: WEB_BASE.replace(/^\//, ""),
              apiBase: WEB_BASE + "/api",
              pluginName: ent.name,
              pluginDir: path.join(pluginsRoot, ent.name),
              logger,
              requireAuth: apiAuthGuard,
              registerApi: (method, route, ...handlers) => Bot.webAdapter.registerApi(method, route, ...handlers),
              registerPage: (def) => registerWebPage(ent.name, def),
              registerPages: (arr) => (Array.isArray(arr) ? arr : []).forEach(d => registerWebPage(ent.name, d)),
            })
            webInited.add(opPath)
            logger.info(logger.green(`[QQBot-Web] 已初始化 ${ent.name} 的 web 操作模块`))
          }
        } catch (e) {
          logger.error(`[QQBot-Web] 初始化 ${ent.name} 的 web 操作模块失败:`, e.message)
        }
      }
    }
    logger.info(logger.green(`[QQBot-Web] 已扫描到 ${webPages.size} 个自定义页面`))
  } catch (e) {
    logger.error("[QQBot-Web] 扫描自定义页面出错:", e)
  }
}

// 开机扫描（插件文件已全在磁盘，与加载顺序无关）；bot 上线后再扫一次以纳入编程式注册
scanWebPages()
// ========== WebAdapter 接口鉴权（统一防护） ==========
// 所有 /api/* 请求（含「约定式操作模块」注册的插件接口）都必须通过：
//   1) 公网访问控制（publicAccess 关闭时仅放行内网 IP）
//   2) 登录鉴权（未登录返回 401）
// 插件既可依赖下方的前置中间件自动生效，也可通过 Bot.webAdapter.requireAuth /
// registerApi 显式挂载，确保与全局策略一致。
async function apiAuthGuard(req, res, next) {
  const fullPath = (req.baseUrl || "") + (req.path || "")
  const loginFree = new Set([
    `${WEB_BASE}/api/login`,
    `${WEB_BASE}/api/logout`,
    `${WEB_BASE}/api/login/captcha`,
    `${WEB_BASE}/api/login/status`,
  ])
  if (loginFree.has(fullPath)) return next()
  if (config.login?.enabled === false) return next()
  if (config.publicAccess !== true) {
    if (fullPath === `${WEB_BASE}/api/health`) return next()
    const ip = getClientIp(req)
    if (!isPrivateIp(ip)) {
      return res.status(403).json({ error: "公网访问已关闭，请通过内网访问控制台" })
    }
  }
  if (await getSession(req)) return next()
  return res.status(401).json({ error: "未登录" })
}

// 编程式注册接口（供其他插件调用）
Bot.webAdapter = Bot.webAdapter || {}
Bot.webAdapter.registerPage = (pluginName, def) => registerWebPage(pluginName, def)
Bot.webAdapter.registerPages = (pluginName, arr) => (Array.isArray(arr) ? arr : []).forEach(d => registerWebPage(pluginName, d))
Bot.webAdapter.getPages = () => [...webPages.values()].sort((a, b) => a.priority - b.priority)
Bot.webAdapter.scan = () => scanWebPages()
// 接口鉴权中间件（供插件在自定义路由中复用）
Bot.webAdapter.requireAuth = apiAuthGuard
// 自动鉴权注册：registerApi(method, route, ...handlers)
//   route 可为相对路径（/foo）或完整路径（/web/api/foo），均自动套用 apiAuthGuard
Bot.webAdapter.registerApi = (method, route, ...handlers) => {
  if (!Bot.express || typeof Bot.express[method] !== "function") return
  const full = String(route).startsWith("/")
    ? `${WEB_BASE}/api${String(route)}`
    : route
  Bot.express[method](full, apiAuthGuard, ...handlers)
}

// ========== 兼容 Yunzai 全局鉴权（server.yaml）—— WebSocket 部分 ==========
// 读取 Yunzai config/config/server.yaml 的 server.auth，序列化为 URL query 字符串。
// 若服务端未配置鉴权则返回空串。
// 返回给前端后仅用于拼接 ws 地址（浏览器 WebSocket 无法自定义 header，只能走 query）。
// 注意：该接口受 apiAuthGuard 登录鉴权保护，不会对未登录请求泄露鉴权参数。
async function readYunzaiServerAuthQuery() {
  try {
    const file = path.join(__dirname, "..", "..", "config", "config", "server.yaml")
    const raw = await fs.readFile(file, "utf8")
    const root = YAML.parse(raw) || {}
    // server.yaml 的 auth 位于顶层（与 url/port/https 平级），cfg.server 即对应此 YAML 根对象；
    // 少数 fork 也兼容 server: 子级嵌套写法。
    const auth = root.auth ?? root.server?.auth
    if (!auth || typeof auth !== "object") return ""
    return Object.entries(auth)
      .map(([k, v]) => `${encodeURIComponent(String(k))}=${encodeURIComponent(String(v))}`)
      .join("&")
  } catch {
    return ""
  }
}
Bot.webAdapter.registerApi("get", "/ws-auth", async (_req, res) => {
  res.json({ query: await readYunzaiServerAuthQuery() })
})


// 沙盒页面 API：发送用户消息 / 触发系统通知（交由 QQBotSandbox adapter 处理，复用真实事件链路）
Bot.webAdapter.registerApi("post", "/qqbot-sandbox/send", async (req, res) => {
  try {
    const sb = Bot.adapter.find(a => a.id === "QQBotSandbox")
    if (!sb) return res.json({ ok: false, error: "沙盒 adapter 未加载" })
    const body = req.body || {}
    const data = sb.message({
      groupId: body.groupId, userId: body.userId, userName: body.userName,
      text: body.text, image: body.image, at: body.at, private: !!body.private,
    })
    res.json({ ok: true, message_id: data.message_id })
  } catch (e) { res.json({ ok: false, error: e.message }) }
})
Bot.webAdapter.registerApi("post", "/qqbot-sandbox/notice", async (req, res) => {
  try {
    const sb = Bot.adapter.find(a => a.id === "QQBotSandbox")
    if (!sb) return res.json({ ok: false, error: "沙盒 adapter 未加载" })
    const body = req.body || {}
    const notice = sb.notice({
      groupId: body.groupId, userId: body.userId, userName: body.userName,
      noticeType: body.noticeType, subType: body.subType, text: body.text,
      groupName: body.groupName, operatorId: body.operatorId,
      applySource: body.applySource, verifyInfo: body.verifyInfo,
      joinRequestId: body.joinRequestId,
    })
    res.json({ ok: true, notice })
  } catch (e) { res.json({ ok: false, error: e.message }) }
})
// 轮询兜底：页面在 WS 不可用时拉取 bot 回复（拉取即清空，单用户沙盒足够）
Bot.webAdapter.registerApi("get", "/qqbot-sandbox/outbox", async (_req, res) => {
  try {
    const sb = Bot.adapter.find(a => a.id === "QQBotSandbox")
    if (!sb || !sb.sandboxOutbox) return res.json({ ok: true, items: [] })
    const items = sb.sandboxOutbox.splice(0, sb.sandboxOutbox.length)
    res.json({ ok: true, items })
  } catch (e) { res.json({ ok: false, error: e.message }) }
})

// 沙盒媒体统一端点：插件回复中的图片可能来自外部 QQ CDN，也可能来自任意 bot
// 的本地 data/imgs/ 目录（但 local-media 端点把目录锁死在 QQBot-Plugin，且外部直链
// 常被防盗链拦截）。该端点自动识别输入类型并统一回源，避免沙盒内图片 403/无法查看。
//   ?url=    http(s) 外链 → 走白名单代理（与 image-proxy 一致）
//   ?path=   本地相对路径 → 在 QQBot-Plugin 数据目录（含 data/imgs、data/emoji）下安全查找
//   ?p=      兼容 local-media 形式的 path 参数（data/imgs/xxx.png）
Bot.webAdapter.registerApi("get", "/qqbot-sandbox/media", async (req, res) => {
  try {
    const ext = path.extname
    const mimeMap = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
      '.mp4': 'video/mp4', '.webm': 'video/webm',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    }
    const sendLocal = (filePath) => {
      const ct = mimeMap[ext(filePath).toLowerCase()] || 'application/octet-stream'
      res.set('Content-Type', ct)
      res.set('Cache-Control', 'public, max-age=86400')
      res.sendFile(filePath)
    }

    const rawUrl = req.query.url
    // 1) 外部 http(s) 链接 → 走代理（复用白名单）
    if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
      let parsedUrl
      try { parsedUrl = new URL(rawUrl) } catch { return res.status(400).end('invalid url') }
      const hostname = parsedUrl.hostname.toLowerCase()
      const allowed = IMAGE_PROXY_ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h))
      if (!allowed) return res.status(403).end('host not allowed')
      try {
        const buf = await Bot.Buffer(rawUrl, { http: true })
        let ct = 'image/jpeg'
        const m = rawUrl.match(/\.(\w+)(?:\?|$)/i)
        if (m && mimeMap['.' + m[1].toLowerCase()]) ct = mimeMap['.' + m[1].toLowerCase()]
        res.set('Content-Type', ct)
        res.set('Content-Length', buf.length)
        res.set('Cache-Control', 'public, max-age=86400')
        res.send(buf)
      } catch (err) {
        logger.debug(`[QQBot-Web] sandbox/media 代理失败: ${err.message}`)
        res.status(502).end()
      }
      return
    }

    // 2) 本地路径（path 或 p 参数）
    const rawRel = req.query.path || req.query.p
    if (!rawRel) return res.status(400).end('missing url or path')

    let rel
    try { rel = decodeURIComponent(rawRel).split(/[?#]/)[0] } catch { return res.status(400).end('invalid path') }
    rel = rel.replace(/^\/+/, '')
    let relNorm
    try { relNorm = path.normalize(rel) } catch { return res.status(400).end('invalid path') }
    if (relNorm === '' || relNorm.startsWith('/') || relNorm.startsWith('\\') || relNorm.split(/[\\/]/).includes('..')) {
      return res.status(403).end('forbidden')
    }

    // 兼容 saveMediaFile 返回的 "data/imgs/xxx" 前缀，剥离后再拼接
    const mediaPrefix = `data${path.sep}imgs${path.sep}`
    const mediaPrefixFlat = 'data/imgs/'
    if (relNorm.startsWith(mediaPrefix)) relNorm = relNorm.slice(mediaPrefix.length)
    else if (relNorm.replace(/\\/g, '/').startsWith(mediaPrefixFlat)) {
      relNorm = relNorm.slice(mediaPrefixFlat.length)
    }

    // 在 QQBot-Plugin 数据目录下查找（imgs 与 emoji 均可）
    const candidates = [
      path.join(QQBT_DATA_IMGS_DIR, relNorm),
      path.join(QQBT_DATA_EMOJI_DIR, relNorm),
    ]
    for (const fp of candidates) {
      const base = path.dirname(fp)
      if (fp !== base && !fp.startsWith(base + path.sep)) continue
      try { await fs.access(fp); return sendLocal(fp) } catch {}
    }
    return res.status(404).end('not found')
  } catch (e) {
    logger.debug(`[QQBot-Web] sandbox/media 异常: ${e.message}`)
    res.status(500).end()
  }
})

// 当前选中的 Bot 直接存于进程内存（由主页面 selectBot 时上报），不落 Redis；
// 各业务接口直接读取，自定义页面无需关心、也无需自行维护。
let selectedSelfId = null

/** 读取当前选中的 Bot selfId（无则返回 null） */
function getSelectedSelfId() {
  return selectedSelfId || null
}

// 主页面切换/清除选中 Bot 时调用，写入进程内存
Bot.webAdapter.registerApi("post", "/select-bot", async (req, res) => {
  selectedSelfId = req.body?.selfId || null
  res.json({ ok: true, selfId: selectedSelfId })
})
// 暴露给插件：业务接口可直接获取当前选中的 Bot
Bot.webAdapter.getSelectedSelfId = getSelectedSelfId

// 前置鉴权中间件：必须在 scanWebPages() 之前注册，
// 否则插件在 init() 中注册的路由会早于全局鉴权中间件而绕过校验。
Bot.express.use(`${WEB_BASE}/api`, apiAuthGuard)

;["login", "plugins/loaded"].forEach(ev => {
  if (typeof Bot.on === "function") {
    try { Bot.on(ev, () => { try { scanWebPages() } catch {} }) } catch {}
  }
})

// ========== 运行时提高 Express body 大小限制（免改 lib/bot.js） ==========
{
  try {
    const app = Bot.express
    // 寻找路由栈：Express 4 用 _router，Express 5 getter 可能抛 deprecation
    let stack = app?._router?.stack
    if (!stack) {
      try { stack = app?.router?.stack } catch {} // Express 5 可能抛错
    }
    if (!stack) {
      // 暴力搜索：遍历 app 自身属性找包含 stack 数组的对象
      for (const key of Object.getOwnPropertyNames(app || {})) {
        try {
          const v = app[key]
          if (v && Array.isArray(v.stack) && v.stack.length > 3) { stack = v.stack; break }
        } catch {}
      }
    }
    if (stack) {
      for (const layer of stack) {
        const name = layer.handle?.name || ""
        if (name === "jsonParser") {
          layer.handle = express.json({ limit: "200mb" })
          logger.info(logger.green("[QQBot-Web] 已调整 json body 大小限制 → 200mb"))
        } else if (name === "rawParser") {
          layer.handle = express.raw({ limit: "200mb" })
          logger.info(logger.green("[QQBot-Web] 已调整 raw body 大小限制 → 200mb"))
        }
      }
    }
  } catch (e) {
    logger.warn(`[QQBot-Web] body 限制调整失败: ${e.message}`)
  }
}

// 兜底：PayloadTooLarge 错误友好提示
Bot.express.use(`${WEB_BASE}`, (err, req, res, next) => {
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return res.status(413).json({ error: "请求体过大，请压缩图片或减小文件后重试" })
  }
  next(err)
})

// ========== 登录鉴权 ==========
const SESSION_TTL = 24 * 3600 // 24 小时（秒）
const REDIS_SESSION_PREFIX = "wind-session:" // Redis 前缀

function genToken() {
  return crypto.randomBytes(32).toString("hex")
}

/** 从请求 cookie 中提取 session token */
function getSessionToken(req) {
  const cookie = req.headers?.cookie || ""
  const match = cookie.match(/qqbot_session=([^;]+)/)
  return match?.[1] || null
}

/** 从请求 cookie 中提取设备标识 */
function getDeviceId(req) {
  const cookie = req.headers?.cookie || ""
  const match = cookie.match(/qqbot_device=([^;]+)/)
  return match?.[1] || ""
}

// 将会话存到 Redis（持久化，服务重启不丢失）
async function setSession(token, username) {
  await redis.setEx(`${REDIS_SESSION_PREFIX}${token}`, SESSION_TTL, username)
}

// 从 Redis 获取并验证会话
async function getSession(req) {
  const token = getSessionToken(req)
  if (!token) return null
  try {
    const username = await redis.get(`${REDIS_SESSION_PREFIX}${token}`)
    if (!username) return null
    return { username }
  } catch {
    return null
  }
}

// 删除会话
async function deleteSession(token) {
  try {
    await redis.del(`${REDIS_SESSION_PREFIX}${token}`)
  } catch {}
}

// 清除所有 session（凭据变更时调用）
async function purgeAllSessions() {
  const pattern = `${REDIS_SESSION_PREFIX}*`
  let cursor = "0"
  do {
    try {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100)
      cursor = nextCursor
      if (keys && keys.length) await redis.del(...keys)
    } catch {
      break
    }
  } while (cursor !== "0")
}

// ========== 防暴力破解 ==========
const LOGIN_FAIL_THRESHOLD = 5           // 失败5次后触发设备级封禁（永久，需验证码解封）
const LOGIN_ATTEMPTS_TTL = 30 * 60      // 失败计数30分钟过期
const LOGIN_CAPTCHA_TTL = 3 * 60        // 验证码3分钟有效期
const LOGIN_CAPTCHA_COOLDOWN = 60       // 验证码发送间隔60秒

const REDIS_ATTEMPTS_PREFIX = "wind-login-attempts:"       // deviceId → 失败次数
const REDIS_BLOCKED_PREFIX = "wind-login-blocked:"          // deviceId → 1（设备级封禁）
const REDIS_CAPTCHA_PREFIX = "wind-login-captcha:"          // ip → code
const REDIS_CAPTCHA_TIME_PREFIX = "wind-login-captcha-time:" // ip → 冷却
const REDIS_DEVICE_PREFIX = "wind-login-device:"            // username → Set<deviceId>

const DEVICE_COOKIE = "qqbot_device"
const DEVICE_TTL = 365 * 24 * 3600  // 设备信任 1 年

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
         req.headers["x-real-ip"] ||
         req.socket?.remoteAddress ||
         "127.0.0.1"
}

// 判断是否为内网/本机 IP（支持 IPv4 + IPv6）
function isPrivateIp(ip) {
  if (!ip) return true
  // 移除 IPv4-mapped IPv6 前缀 ::ffff:
  const s = ip.replace(/^::ffff:/, "")
  // IPv4 回环 & 私有段
  if (s === "127.0.0.1" || s === "localhost") return true
  if (s.startsWith("10.") || s.startsWith("192.168.")) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true
  // IPv6 回环 & 私有段
  if (s === "::1") return true
  if (/^f[cde][0-9a-f]{0,2}:/i.test(s)) return true  // fc00::/7 (ULA) + fe80::/10 (link-local)
  return false
}

// 国家代码 → 中文名（geoip-lite 返回英文代码）
const _COUNTRY_CN = {
  CN: "中国", HK: "中国香港", TW: "中国台湾", MO: "中国澳门",
  US: "美国", JP: "日本", KR: "韩国", SG: "新加坡",
  GB: "英国", DE: "德国", FR: "法国", CA: "加拿大",
  AU: "澳大利亚", RU: "俄罗斯", IN: "印度", TH: "泰国",
  VN: "越南", MY: "马来西亚", PH: "菲律宾", ID: "印度尼西亚",
}
const _countryCN = (code) => _COUNTRY_CN[code] || code || ""

// IP 归属地查询（IPv4: ip-geo-cn 纯真库, IPv6: geoip-lite + 前缀识别）
async function getIpRegion(ip) {
  if (!ip) return "未知地区"
  if (isPrivateIp(ip)) return "局域网"
  try {
    const s = ip.replace(/^::ffff:/, "")
    const isV6 = s.includes(":")
    if (!isV6 && qqwry) {
      // IPv4: 纯真数据库（中国省市 ISP 精度最优）
      const r = qqwry.searchIP(s)
      if (r?.Country) {
        const parts = [r.Country]
        if (r.Area && r.Area !== r.Country) parts.push(r.Area)
        return parts.join(" ") || "未知地区"
      }
    }
    // IPv6 或无纯真数据时：geoip-lite + 前缀识别
    if (!geoip) return isV6 ? (guessIPv6ISP(s) || "未知地区") : "未知地区"
    const geo = geoip.lookup(s)
    if (!geo?.country) return isV6 ? (guessIPv6ISP(s) || "未知地区") : "未知地区"
    const country = _countryCN(geo.country)
    const parts = [country]
    if (geo.region) parts.push(geo.region)
    if (geo.city && geo.city !== geo.region) parts.push(geo.city)
    const region = parts.filter(Boolean).join(" ")
    if (!geo.region && isV6) {
      const isp = guessIPv6ISP(s)
      if (isp && isp !== country) return isp
    }
    return region || "未知地区"
  } catch {}
  return "未知地区"
}

// IPv6 前缀 → 运营商（中国常见前缀，中国移动/电信/联通在 2409::/16 内有不同分配）
function guessIPv6ISP(ip) {
  if (/^240e/i.test(ip)) return "中国 电信"
  if (/^2408/i.test(ip)) return "中国 联通"
  if (/^2409:8[0-8]/i.test(ip)) return "中国 移动"
  if (/^2409:8a/i.test(ip)) return "中国 移动"
  if (/^2409:9/i.test(ip)) return "中国 移动"
  if (/^2409:89/i.test(ip)) return "中国 电信"
  if (/^2001:da8/i.test(ip)) return "中国 教育网"
  if (/^240[0-9a-f]:/i.test(ip)) return "中国"
  return ""
}

// 登录失败通知（达到阈值时向 notifyUserId 推送）
async function notifyLoginFailure(ip, username, attemptCount) {
  const notifyId = config.notifyUserId?.trim()
  if (!notifyId) return
  try {
    let targetBotId = null
    let resolvedUserId = notifyId
    if (Bot.uin?.length > 0) {
      for (const id of Bot.uin) {
        if (!Bot[id]?.adapter) continue
        if (Bot[id].fl?.has?.(notifyId)) { targetBotId = id; break }
        const sep = Bot[id].adapter.sep
        if (sep) {
          const lookupKey = `${id}${sep}${notifyId}`
          if (Bot[id].fl?.has?.(lookupKey)) { targetBotId = id; resolvedUserId = lookupKey; break }
        }
      }
    }
    if (targetBotId) {
      const region = await getIpRegion(ip)
      const time = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
      const msg = `【登录失败提醒】\n用户名：${username}\nIP：${ip}\n地区：${region}\n失败次数：${attemptCount}/${LOGIN_FAIL_THRESHOLD}\n时间：${time}`
      await Bot.sendFriendMsg(targetBotId, resolvedUserId, msg)
    }
  } catch {}
}

// ========== API 频率限制（内存） ==========
const RATELIMIT_WINDOW = 60          // 窗口 60 秒
const RATELIMIT_MAX = 500            // 普通接口每窗口最多 500 次（含消息加载/翻页等高频操作）
const RATELIMIT_LOGIN_MAX = 10       // 登录接口每窗口最多 10 次
const rateLimitMap = new Map()       // ip → { count, resetTime, loginCount }

function rateLimitMiddleware(maxPerWindow, loginMax) {
  return (req, res, next) => {
    const ip = getClientIp(req)
    const now = Date.now()
    let entry = rateLimitMap.get(ip)
    if (!entry || now > entry.resetTime) {
      entry = { count: 0, loginCount: 0, resetTime: now + RATELIMIT_WINDOW * 1000 }
      rateLimitMap.set(ip, entry)
    }
    entry.count++
    // 登录/验证码接口额外限制
    const isLoginPath = req.path === "/api/login" || req.path === "/api/login/captcha"
    if (isLoginPath) entry.loginCount++
    if (entry.count > maxPerWindow || (isLoginPath && entry.loginCount > loginMax)) {
      return res.status(429).json({ error: "请求过于频繁，请稍后再试" })
    }
    next()
  }
}

// 定期清理过期条目
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetTime) rateLimitMap.delete(ip)
  }
}, 60000)

// ========== 添加 Bot 相关（AppID 登录 / 扫码登录） ==========
const QQBot_ConfigFile = path.resolve(path.dirname(__dirname), "..", "config", "QQBot.yaml")

// 扫码登录常量
const QR_PORTAL_HOST = "q.qq.com"
const QR_CREATE_PATH = "/lite/create_bind_task"
const QR_POLL_PATH = "/lite/poll_bind_result"
const QR_URL_TPL = "https://q.qq.com/qqbot/openclaw/connect.html?task_id={task_id}&_wv=2&source=windtrace"
const QR_SHARE_INFO_URL = "https://qun.qq.com/cgi-bin/group_pro/robot/manager/share_info"
const QR_BKN = 508459323
const QR_HEADERS = { "Content-Type": "application/json", "User-Agent": "windtrace/1.0", "X-Source": "windtrace" }

async function qrCreateBindTask() {
  const key = crypto.randomBytes(32).toString("base64")
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(`https://${QR_PORTAL_HOST}${QR_CREATE_PATH}`, {
      method: "POST", headers: QR_HEADERS, body: JSON.stringify({ key }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`创建绑定任务失败(HTTP ${res.status})`)
    let json
    try {
      json = await res.json()
    } catch {
      throw new Error("创建绑定任务失败：接口返回非 JSON（可能被网络/代理拦截）")
    }
    if (json.retcode !== 0) throw new Error(json.msg || "创建绑定任务失败")
    return { taskId: json.data.task_id, key }
  } catch (err) {
    clearTimeout(timer)
    throw err.name === "AbortError" ? new Error("创建二维码超时，QQ 接口无响应") : err
  }
}

async function qrPollBindResult(taskId) {
  const res = await fetch(`https://${QR_PORTAL_HOST}${QR_POLL_PATH}`, {
    method: "POST", headers: QR_HEADERS, body: JSON.stringify({ task_id: taskId }),
  })
  // 网络/代理可能返回非 JSON（HTML 错误页等），直接解析会抛 SyntaxError 导致 500；
  // 这里做容错：非 2xx 或非 JSON 一律当作 waiting，前端继续轮询，不中断扫码流程
  if (!res.ok) return { status: "waiting" }
  let json
  try {
    json = await res.json()
  } catch {
    return { status: "waiting" }
  }
  if (json.retcode !== 0) return { status: "waiting" }
  if (json.data.status === 2) return { status: "ok", data: json.data }
  if (json.data.status === 3) return { status: "timeout" }
  return { status: "waiting" }
}

function qrDecryptSecret(cipherBase64, keyBase64) {
  const buf = Buffer.from(cipherBase64, "base64")
  const key = Buffer.from(keyBase64, "base64")
  const nonce = buf.subarray(0, 12), tag = buf.subarray(-16), cipher = buf.subarray(12, -16)
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce)
  decipher.setAuthTag(tag)
  return decipher.update(cipher, undefined, "utf8") + decipher.final("utf8")
}

async function qrGetRobotUin(appId) {
  try {
    const res = await fetch(`${QR_SHARE_INFO_URL}?bkn=${QR_BKN}&robot_appid=${appId}`, {
      method: "GET", headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36'
      }
    })
    if (!res.ok) return null
    const json = await res.json()
    return json?.data?.robot_data?.robot_uin
  } catch {
    // 接口返回非 JSON（被网络/代理拦截）时容错，交由上层提示
    return null
  }
}

// 将（新旧）token 统一规范为 bot 对象：{ QQ, appid, secret, webhook, private, group }
// 旧格式为字符串：uin:appid:占位:secret:connMode:pdFlag
function normalizeToken(t) {
  if (typeof t === "string") {
    const p = t.split(":")
    // 旧格式：QQ:appid:token:secret:群权限:私域权限
    // 群权限位为 "2" 表示 webhook 模式（此时不写 private/group）
    const webhook = p[4] === "2"
    const o = {
      QQ: p[0],
      appid: p[1],
      secret: p[3],
      webhook,
    }
    // 仅非 webhook 模式保留群事件与频道私域权限字段
    if (!webhook) {
      o.group = p[4] === "1"
      o.private = p[5] === "1"
    }
    return o
  }
  const webhook = !!t.webhook
  const o = {
    QQ: t.QQ,
    appid: t.appid,
    secret: t.secret,
    webhook,
  }
  // Webhook 模式无需频道私域权限与群事件字段，避免误导
  if (!webhook) {
    o.private = t.private === true
    o.group = !!t.group
  }
  return o
}

// 读取 QQBot 配置（兼容旧版字符串 token，自动迁移为 bot 对象数组）
async function readQQBotConfig() {
  let cfg
  try {
    const raw = await fs.readFile(QQBot_ConfigFile, "utf8")
    cfg = YAML.parse(raw) || {}
  } catch { return {} }
  if (Array.isArray(cfg.token)) {
    let needMigrate = false
    cfg.token = cfg.token.map(t => {
      if (typeof t === "string") { needMigrate = true; return normalizeToken(t) }
      return t
    })
    if (needMigrate) {
      try { await writeQQBotConfig(cfg) } catch {}
    }
  }
  return cfg
}

// 写入 QQBot 配置
async function writeQQBotConfig(qqbotConfig) {
  await fs.writeFile(QQBot_ConfigFile, YAML.stringify(qqbotConfig), "utf8")
}

// 保存 token 到 QQBot 配置并热连接（与 QQBot-Plugin 的 _saveAndConnectBot 逻辑一致）
const _connectLocks = new Map()
async function saveAndConnectBot(uin, appid, secret, connMode = "1", pdFlag = "0") {
  const uinStr = String(uin)
  // 防止同一 Bot 并发连接
  if (_connectLocks.has(uinStr)) return await _connectLocks.get(uinStr)
  let lockResolve
  _connectLocks.set(uinStr, new Promise(r => { lockResolve = r }))

  let botObj = null
  try {
    // 新格式：config.token 为 bot 对象数组（与 QQBot-Plugin 的 connect 一致）
    const webhook = connMode === "2"
    botObj = {
      QQ: uin,
      appid,
      secret,
      webhook,
    }
    // Webhook 模式无需频道私域权限与群事件字段，避免误导
    if (!webhook) {
      botObj.private = pdFlag === "1"
      botObj.group = false
    }

    const qqbotConfig = await readQQBotConfig()
    if (!Array.isArray(qqbotConfig.token)) qqbotConfig.token = []

    const idx = qqbotConfig.token.findIndex(t => String(t?.QQ) === uinStr)
    if (idx >= 0) {
      qqbotConfig.token[idx] = botObj
    } else {
      qqbotConfig.token.push(botObj)
    }
    await writeQQBotConfig(qqbotConfig)

    // 热加载 Bot 实例
    if (Bot[uinStr] && Bot[uinStr].sdk?.config) {
      // 已有实例：不调用 connect()（会重建 Bot[id] 导致 LevelDB 文件锁冲突）
      // 直接更新已存在的 config，用 sessionManager 重新连接
      const sm = Bot[uinStr].sdk.sessionManager
      if (sm) {
        sm.userClose = true
      }
      try { Bot[uinStr].sdk.stop() } catch {}
      await new Promise(r => setTimeout(r, 500))
      // 更新 secret
      Bot[uinStr].sdk.config.secret = secret
      Bot[uinStr].info.secret = secret
      if (sm) {
        sm.tokenTask = null
        if (sm.tokenTimer) { clearTimeout(sm.tokenTimer); sm.tokenTimer = null }
        sm.wsUrl = null
        sm.access_token = null
        sm.fatalError = false
        sm.userClose = false
        sm.retry = 0
        await sm.start()
      }
      logger.mark(`[QQBot-Web] Bot ${uinStr} 配置已更新并重新连接`)
    } else {
      // 新 Bot：调用 QQBot-Plugin 的 connect（传入 bot 对象）
      const qqbotAdapter = Bot.adapter?.find(a => typeof a.connect === "function")
      if (qqbotAdapter) {
        await qqbotAdapter.connect(botObj)
        await new Promise(r => setTimeout(r, 1000))
      }
      logger.mark(`[QQBot-Web] Bot ${uinStr} 已添加并连接`)
    }

    return { uin: uinStr, appid: String(appid), token: botObj, existed: idx >= 0 }
  } catch (e) {
    logger.debug(`[QQBot-Web] Bot ${uinStr} 热加载失败: ${e.message}，重启后生效`)
    return { uin: uinStr, appid: String(appid), token: botObj, existed: false }
  } finally {
    _connectLocks.delete(uinStr)
    lockResolve()
  }
}

/** 解析 fastfetch 输出为结构化 HTML（参考 state-plugin） */
function parseFastfetch(output) {
  const lines = output.split("\n").filter(line => line.includes(":"))
  return lines.map(line => {
    const idx = line.indexOf(":")
    const key = escHtml(line.substring(0, idx).trim())
    const value = escHtml(line.substring(idx + 1).trim())
    return `<div class="ff-row"><span class="ff-key">${key}</span><span class="ff-sep">: </span><span class="ff-val">${value}</span></div>`
  }).join("")
}

function escHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** fastfetch/neowofetch 都不可用时，用 Node.js 数据生成基础系统信息 */
function buildSystemProfileHtml(sys, cpuModel, cpuCores, cpuSpeed, uptime, totalMem, webVer, qqVer) {
  const lines = [
    ["OS", `${capitalize(sys.platform)} ${sys.release}`],
    ["Host", sys.hostname],
    ["Arch", sys.arch],
    ["CPU", `${cpuModel || "Unknown"} (${cpuCores}c @ ${cpuSpeed ? cpuSpeed + "MHz" : "?"})`],
    ["Memory", `${fmtMem(totalMem)}`],
    ["Uptime", fmtUptime(uptime)],
    ["Node", process.version],
    ["WebAdapter", webVer],
    ["QQBotPlugin", qqVer],
  ]
  return lines.map(([key, val]) =>
    `<div class="ff-row"><span class="ff-key">${escHtml(key)}</span><span class="ff-sep">: </span><span class="ff-val">${escHtml(val)}</span></div>`
  ).join("")
}

// ========== fastfetch 异步预计算（避免 execSync 阻塞事件循环） ==========

const execAsync = promisify(execCb)

// 缓存：启动时同步快速检测一次，有则异步执行，无则立即标记完成
let cachedFastfetchHtml = null
let fastfetchComputed = false
let fastfetchComputing = false

// 同步快速检测 fastfetch 是否存在（which 耗时极短，不会明显阻塞）
const fastfetchAvailable = (() => {
  try {
    const whichCmd = process.platform === "win32" ? "where fastfetch" : "which fastfetch"
    execSync(whichCmd, { timeout: 2000, windowsHide: true })
    return true
  } catch { return false }
})()

async function computeFastfetchInBackground() {
  if (fastfetchComputing || fastfetchComputed) return
  fastfetchComputing = true

  if (!fastfetchAvailable) {
    // 没有 fastfetch → 直接标记完成，不尝试 neowofetch 下载
    fastfetchComputed = true
    return
  }

  try {
    const { stdout } = await execAsync("fastfetch --pipe -l none", { timeout: 4000, encoding: "utf-8" })
    const raw = stdout?.trim()
    if (raw) cachedFastfetchHtml = parseFastfetch(raw)
  } catch {}

  fastfetchComputed = true
}

function capitalize(s) {
  if (!s) return ""
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function fmtMem(bytes) {
  if (!bytes || bytes <= 0) return "0 GB"
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB"
}

function fmtUptime(seconds) {
  if (!seconds || seconds < 0) return "0m"
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m || !parts.length) parts.push(`${m}m`)
  return parts.join(" ")
}

// ========== WebSocket 实时推送 ==========
const wsClients = new Map() // conn → { selfId, groups: Set, privates: Set }

// 向指定群的订阅客户端推送消息
function wsBroadcast(selfId, groupId, data) {
  for (const [conn, info] of wsClients) {
    if (info.selfId === selfId && info.groups.has(groupId)) {
      try {
        conn.sendMsg(JSON.stringify(data))
      } catch {}
    }
  }
}

// 向指定私聊的订阅客户端推送消息
function wsBroadcastPrivate(selfId, userId, data) {
  for (const [conn, info] of wsClients) {
    if (info.selfId === selfId && info.privates && info.privates.has(String(userId))) {
      try {
        conn.sendMsg(JSON.stringify(data))
      } catch {}
    }
  }
}

// 向指定 selfId 下所有客户端广播（用于群名等全局信息变更，不限于订阅的群）
function wsBroadcastAll(selfId, data) {
  for (const [conn, info] of wsClients) {
    if (info.selfId === selfId) {
      try {
        conn.sendMsg(JSON.stringify(data))
      } catch {}
    }
  }
}

Bot.wsf[WS_PATH] = [(conn, req) => {
  // WebSocket 鉴权：仅当登录开关开启时检查 session
  if (config.login?.enabled !== false) {
    const token = getSessionToken(req)
    if (!token) {
      conn.sendMsg(JSON.stringify({ type: "auth_error", error: "未登录" }))
      conn.close()
      return
    }
    // 异步验证 session，通过后再注册连接
    redis.get(`${REDIS_SESSION_PREFIX}${token}`).then(username => {
      if (!username) {
        try { conn.sendMsg(JSON.stringify({ type: "auth_error", error: "session 已过期" })); conn.close() } catch {}
        return
      }
      setupWsClient(conn)
    }).catch(() => {
      try { conn.sendMsg(JSON.stringify({ type: "auth_error", error: "鉴权失败" })); conn.close() } catch {}
    })
    return
  }

  setupWsClient(conn)
}]

function setupWsClient(conn) {
  const info = { selfId: null, groups: new Set(), privates: new Set() }
  wsClients.set(conn, info)

  conn.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.type === "watch") {
        info.selfId = msg.selfId
        if (msg.groupId) info.groups.add(msg.groupId)
        if (msg.privateUserId) info.privates.add(String(msg.privateUserId))
      } else if (msg.type === "unwatch") {
        if (msg.groupId) info.groups.delete(msg.groupId)
        if (msg.privateUserId) info.privates.delete(String(msg.privateUserId))
      }
    } catch {}
  })

  conn.on("close", () => wsClients.delete(conn))
}

/**
 * 修复底层库 @windtrace/qq-group-bot 在 MessageEvent.parse 中删除 content 里的 [@username]
 * 并将 at 段追加到末尾的问题。
 * 利用 raw_event.d.content（原始 content）和 raw_event.d.mentions：
 *   - 将 raw_message 中的 [@username] 替换为 <@openid>（前端可识别）
 *   - 将 message 数组末尾的 at segment 移到正确位置（根据 [@xxx] 在 content 中的位置）
 * 直接修改 msg.message 和 msg.raw_message。
 */
function fixAtPositions(msg) {
  const mentions = msg.raw_event?.d?.mentions
  const originalContent = msg.raw_event?.d?.content
  if (!Array.isArray(mentions) || !mentions.length || !originalContent) return

  const sep = Bot[msg.self_id]?.adapter?.sep || ':'

  const mentionMap = new Map() // username → openid
  for (const m of mentions) {
    if (m.username) mentionMap.set(m.username, m.member_openid || m.id || "")
  }
  // 收集 [@username] 在 originalContent 中的位置和对应 openid
  const atReplacements = []
  const atPattern = /\[@([^\]]+)\]/g
  let m
  while ((m = atPattern.exec(originalContent)) !== null) {
    const username = m[1]
    const openid = mentionMap.get(username) || username
    atReplacements.push({ index: m.index, username, openid, length: m[0].length })
  }
  if (!atReplacements.length) return

  // 1. 修复 raw_message：把 content 中的 [@username] 替换为 <@openid>
  let rebuiltRaw = originalContent
  for (const rep of [...atReplacements].reverse()) {
    rebuiltRaw = rebuiltRaw.slice(0, rep.index) + `<@${rep.openid}>` + rebuiltRaw.slice(rep.index + rep.length)
  }
  msg.raw_message = rebuiltRaw

  // 2. 修复 message 数组：从末尾取出 at segment，插入到正确位置
  //    SDK 的 Message.parse 会把所有 mentions 中的 at 段追加到 message 末尾
  //    这里直接收集所有非 scope=all 的 at segment，保持它们在 message 中的原始顺序
  //    这个顺序与 mentions 数组顺序一致，也与 raw_event.d.content 中 [@xxx] 的顺序一致
  const message = Array.isArray(msg.message) ? [...msg.message] : []
  if (!message.length) return

  const atSegsToMove = []
  for (let i = message.length - 1; i >= 0; i--) {
    const seg = message[i]
    if (seg.type !== "at") continue
    if (seg.scope === "all") continue
    atSegsToMove.unshift(message.splice(i, 1)[0])
  }
  if (!atSegsToMove.length) return

  // 如果收集到的 at 数量少于 content 中 [@xxx] 数量：
  //   当同一个人被多次 @ 时，mentions 中只出现一次，SDK 也只追加一个 at segment
  //   需要复制已有的 at segment 来补齐
  if (atSegsToMove.length < atReplacements.length && atSegsToMove.length > 0) {
    // 按 atReplacements 中 openid 顺序，将 at segment 匹配到对应的 [@xxx]
    // 策略：遍历 atReplacements，对于每个 replacement，在 atSegsToMove 中找 openid 匹配的 seg
    const matched = []
    const used = new Set() // 已使用的 atSegsToMove 索引
    for (const rep of atReplacements) {
      let found = -1
      // 优先找 openid 精确匹配且未使用的
      for (let j = 0; j < atSegsToMove.length; j++) {
        if (used.has(j)) continue
        const seg = atSegsToMove[j]
        const segUid = (seg.qq || seg.user_id || "").includes(sep)
          ? (seg.qq || seg.user_id || "").split(sep).pop()
          : (seg.qq || seg.user_id || "")
        if (segUid === rep.openid) { found = j; break }
      }
      if (found >= 0) {
        matched.push(atSegsToMove[found])
        used.add(found)
      } else {
        // 无精确匹配，用第一个未使用的 at segment（深拷贝）
        let fallback = null
        for (let j = 0; j < atSegsToMove.length; j++) {
          if (!used.has(j)) { fallback = j; break }
        }
        if (typeof fallback === 'number' && fallback >= 0) {
          matched.push({ ...atSegsToMove[fallback] })
          // 不标记为 used，允许同一个 seg 被复用多次
        } else if (atSegsToMove.length > 0) {
          // 所有都被用过了，复用第一个
          matched.push({ ...atSegsToMove[0] })
        }
      }
    }
    // 用匹配后的结果替换
    atSegsToMove.length = 0
    atSegsToMove.push(...matched)
  }
  if (!atSegsToMove.length) return

  // 按 [@xxx] 在 content 中的位置，在 message 数组中插入 at segment
  // 策略：用 message 中 text 段的实际内容计算位置，而非依赖 contentNoAt
  //       避免因 contentNoAt 与 message text 内容不一致导致的拆分位置错误

  // 1. 计算每个 [@xxx] 在"纯文本"中的位置
  //    originalContent 中可能有 <...> 标签（表情等），它们在 message 中不是 text 段
  //    需要排除这些标签的长度，才能正确映射到 message 的 text 段
  //    纯文本 = originalContent 去掉 <...> 和 [@xxx] 后的内容
  const tagPattern = /<[^>]+>/g
  let cleanedContent = originalContent
  // 收集所有 <...> 标签的位置和长度
  const tags = []
  let tm
  while ((tm = tagPattern.exec(originalContent)) !== null) {
    tags.push({ index: tm.index, length: tm[0].length })
  }

  // 对于每个 [@xxx]，计算它在纯文本中的位置
  // = index - 前面 [@xxx] 的总长度 - 前面 <...> 的总长度
  const sortedReps = [...atReplacements].sort((a, b) => a.index - b.index)
  let cumulativeAtLen = 0
  const atPositions = [] // 每个 at 在纯文本中的位置
  for (const rep of sortedReps) {
    // 计算 rep.index 之前有多少个 <...> 标签的字符
    let tagLenBefore = 0
    for (const tag of tags) {
      if (tag.index < rep.index) tagLenBefore += tag.length
    }
    const pos = rep.index - cumulativeAtLen - tagLenBefore
    atPositions.push(Math.max(0, pos))
    cumulativeAtLen += rep.length
  }

  // 2. 收集 message 中所有 text 段的信息，记录每个 text 段在拼接文本中的偏移
  const textInfos = [] // { idx, start, end, text }
  let allText = ""
  for (let i = 0; i < message.length; i++) {
    const seg = message[i]
    if (seg.type === "text" && typeof seg.text === "string" && seg.text.length > 0) {
      const start = allText.length
      allText += seg.text
      textInfos.push({ idx: i, start, end: allText.length, text: seg.text })
    }
  }

  // 3. 在 allText 中按 atPositions 插入 at，分割文本
  //    得到 parts: [{type:"text", text}, {type:"at", seg}, ...]
  const parts = []
  let cursor = 0
  for (let i = 0; i < atPositions.length && i < atSegsToMove.length; i++) {
    const pos = atPositions[i]
    const clampedPos = Math.max(0, Math.min(pos, allText.length))
    if (clampedPos > cursor) {
      parts.push({ type: "text", text: allText.slice(cursor, clampedPos) })
    }
    parts.push({ type: "at", seg: atSegsToMove[i] })
    cursor = clampedPos
  }
  if (cursor < allText.length) {
    parts.push({ type: "text", text: allText.slice(cursor) })
  }

  // 4. 重建 message 数组
  //    遍历 message，保留非 text 段在原位
  //    对 text 段，从 parts 中按 allText 偏移范围取出对应的部分
  const result = []
  let partCursor = 0 // 当前在 parts 中的位置
  let textInPartOffset = 0 // 在当前 text part 中的偏移

  for (let i = 0; i < message.length; i++) {
    const seg = message[i]
    if (seg.type !== "text" || typeof seg.text !== "string" || seg.text.length === 0) {
      result.push(seg)
      continue
    }

    // 找到这个 text 段对应的 textInfo
    const info = textInfos.find(t => t.idx === i)
    if (!info) {
      result.push(seg)
      continue
    }

    // 从 parts 中取出 [info.start, info.end) 范围内的内容
    let consumed = 0
    while (consumed < info.text.length && partCursor < parts.length) {
      const part = parts[partCursor]
      if (part.type === "at") {
        result.push(part.seg)
        partCursor++
        textInPartOffset = 0
        continue
      }
      // text part
      const partText = part.text
      const available = partText.length - textInPartOffset
      const needed = info.text.length - consumed
      const take = Math.min(available, needed)
      if (take > 0) {
        result.push({ type: "text", text: partText.slice(textInPartOffset, textInPartOffset + take) })
        textInPartOffset += take
        consumed += take
      }
      if (textInPartOffset >= partText.length) {
        partCursor++
        textInPartOffset = 0
      }
    }
  }

  // 剩余未消费的 parts
  while (partCursor < parts.length) {
    const part = parts[partCursor]
    if (part.type === "at") {
      result.push(part.seg)
    } else {
      const remaining = part.text.slice(textInPartOffset)
      if (remaining.length > 0) {
        result.push({ type: "text", text: remaining })
      }
    }
    partCursor++
    textInPartOffset = 0
  }

  // 过滤空 text segment
  msg.message = result.filter(s => s.type !== "text" || (typeof s.text === "string" && s.text.length > 0))
}

// 将 Bot 事件消息转为前端格式
function eventToMessage(selfId, data) {
  // 过滤掉 face 类型的 segment（表情无法在 Web 端渲染）
  const message = Array.isArray(data.message)
    ? data.message.filter(s => s.type !== "face")
    : data.message
  const rawMessage = data.raw_message || ""

  // 构造消息对象，供 fixAtPositions 原地修改
  const msgObj = {
    message: message || [],
    raw_message: rawMessage,
    raw_event: data.raw_event || null,
    self_id: selfId,
  }
  fixAtPositions(msgObj)

  // 如果 data.ref_msg_idx 为空，尝试从 message 数组中提取 reply segment 的 id
  let refMsgIdx = data.ref_msg_idx || ""
  if (!refMsgIdx && Array.isArray(message)) {
    for (const seg of message) {
      if (seg.type === "reply" && seg.id) {
        refMsgIdx = seg.id
        break
      }
    }
  }

  return {
    user_id: data.user_id || data.openid || "",
    nickname: data.nickname || data.sender?.nickname || data.user_id || "",
    msg_idx: data.msg_idx || "",
    ref_msg_idx: refMsgIdx,
    message_id: data.message_id || "",
    message: msgObj.message || [],
    raw_message: msgObj.raw_message,
    timestamp: data.timestamp || data.time || Date.now() / 1000,
    avatar: data.avatar || data.sender?.avatar || "",
    sender: data.sender || null,
    need_audit: data.need_audit ?? false,
    is_callback: data.sub_type === "callback" || data.is_callback === true,
    is_bot: data.raw_event?.d?.author?.bot || false,
    me: data.me ?? false,
    raw_event: data.raw_event || null,
    event_id: data.event_id || "",
    audit_id: data.audit_id || null,
    openid: data.openid || "",
    unionid: data.unionid || "",
  }
}

// 监听 Bot 消息事件 - 实时推送给 WebSocket 客户端
Bot.on("qqbot_msg", async (data) => {
  try {
    if (!data || !data.self_id || !data.group_id) return
    const selfId = data.self_id
    const sep = Bot[selfId]?.adapter?.sep || ":"
    const normalizedGroupId = data.group_id.startsWith(`${selfId}${sep}`)
      ? data.group_id
      : `${selfId}${sep}${data.group_id}`

    const msgData = eventToMessage(selfId, data)
    // 将 _local 媒体 segment 转为前端可用的 local-media URL
    resolveLocalSegments([msgData], selfId)
    // 异步填充引用消息摘要（不阻塞推送）
    if (msgData.ref_msg_idx) {
      const summaries = await getRefMsgSummaries(selfId, normalizedGroupId, [msgData.ref_msg_idx])
      if (summaries[msgData.ref_msg_idx]) {
        msgData.ref_summary = summaries[msgData.ref_msg_idx]
      } else {
        // 降级：从 raw_event.d.msg_elements 提取被引用消息信息
        const fallback = extractRefFromMsgElements(data.raw_event, selfId)
        if (fallback) { msgData.ref_summary = fallback }
        else { msgData.ref_summary = refSummaryPlaceholder(msgData.ref_msg_idx) }
      }
    }
    // SQLite 存储 — 消息存储实际发生在 QQBot-Plugin/lib/message.js，此处仅 WS 推送
    wsBroadcast(selfId, normalizedGroupId, {
      type: "new_message",
      groupId: normalizedGroupId,
      message: msgData,
    })
  } catch {}
})

// 监听私聊消息事件
Bot.on("qqbot_private_msg", async (data) => {
  try {
    if (!data || !data.self_id || !data.user_id) return
    const selfId = data.self_id
    const msgData = eventToMessage(selfId, data)
    // 将 _local 媒体 segment 转为前端可用的 local-media URL
    resolveLocalSegments([msgData], selfId)
    // 从 fl 补齐昵称
    patchNicknameFromFl(selfId, msgData)
    // 异步填充引用消息摘要
    if (msgData.ref_msg_idx) {
      const summaries = await getRefMsgSummaries(selfId, null, [msgData.ref_msg_idx])
      if (summaries[msgData.ref_msg_idx]) {
        msgData.ref_summary = summaries[msgData.ref_msg_idx]
      } else {
        // 降级：从 raw_event.d.msg_elements 提取被引用消息信息
        const fallback = extractRefFromMsgElements(data.raw_event, selfId)
        if (fallback) { msgData.ref_summary = fallback }
        else { msgData.ref_summary = refSummaryPlaceholder(msgData.ref_msg_idx) }
      }
    }
    wsBroadcastPrivate(selfId, data.user_id, {
      type: "new_private_message",
      privateUserId: String(data.user_id),
      message: msgData,
    })
  } catch {}
})

// 监听群通知事件（进群/退群/机器人被拉入/被踢出）
Bot.on("qqbot_notice", (notice) => {
  try {
    if (!notice || !notice.self_id || !notice.group_id) return
    wsBroadcast(String(notice.self_id), notice.group_id, {
      type: "new_message",
      groupId: notice.group_id,
      message: notice,
    })
  } catch {}
})

// ========== 辅助函数 ==========

// 将 HTTP URL 升级为 HTTPS（避免 Mixed Content）
function toHttps(url) {
  if (!url || !url.startsWith("http://")) return url
  return "https://" + url.slice(7)
}

/**
 * group_id 格式统一：
 * - incoming 消息用完整格式：selfId:groupOpenid
 * - bot 消息存储用纯 group_id：groupOpenid（无 selfId 前缀）
 * 本函数根据 bot 获取纯 groupOpenid
 */
function getPureGroupId(selfId, groupId) {
  const sep = Bot[selfId]?.adapter?.sep || ":"
  if (groupId.startsWith(`${selfId}${sep}`)) {
    return groupId.slice(selfId.length + sep.length)
  }
  return groupId
}

/** 获取 Bot 列表 */
function getBots() {
  const bots = []
  for (const id of Bot.uin) {
    if (!Bot[id]) continue
    if (Bot[id].adapter?.id !== "QQBot") continue
    const info = Bot[id].info || {}
    bots.push({
      self_id: id,
      nickname: info.username || info.nickname || id,
      avatar: toHttps(info.avatar) || `https://q.qlogo.cn/g?b=qq&s=0&nk=${id}`,
      appid: info.appid || "",
      enabled: !Bot[id]._webDisabled,
    })
  }
  return bots
}

/**
 * 获取当前选中的 Bot 完整信息（基于进程内存 selectedSelfId）。
 * 返回 { self_id, nickname, avatar, appid, enabled } 或 null。
 * 暴露为 Bot.webAdapter.getCurrentBot()，供其它自定义页面直接调用。
 */
function getCurrentBot() {
  const sid = getSelectedSelfId()
  if (!sid) return null
  return getBots().find(b => b.self_id === sid) || null
}
Bot.webAdapter.getCurrentBot = getCurrentBot

/** 获取活跃群组名称的辅助函数（同步优先，缺失则异步补） */
// 待补队列 + 速率限制：gl 取不到名称时，先返回兜底 id 让前端立即显示，
// 再把群投入队列，由限速消费者异步调 pickGroup().getGroupInfo() 写回 gl
const _groupNameBacklog = new Map() // key: `${selfId}:${pureId}` -> { selfId, pureId }
let _groupNameConsumerRunning = false
const _GROUP_NAME_INTERVAL = 3000 // 20 QPM：每个群之间间隔 3s 做速率限制

// 是否处于 QQBot 沙箱模式：沙箱下 getGroupInfo 受限，不自动拉取群信息
// 直接从已加载的 QQBot 适配器实例读取 config.bot.sandbox（无需读配置文件）
function isSandboxMode() {
  const adapter = Bot.adapter?.find(a => a.id === "QQBot")
  return adapter?.config?.bot?.sandbox === true
}

async function _groupNameEnqueue(selfId, pureId) {
  const key = `${selfId}:${pureId}`
  if (_groupNameBacklog.has(key)) return
  _groupNameBacklog.set(key, { selfId, pureId })
  if (!_groupNameConsumerRunning) {
    _groupNameConsumerRunning = true
    _groupNameConsume().catch((e) => logger.error(`[QQBot-Web] 群名补取消费异常: ${e}`))
  }
}

async function _groupNameConsume() {
  const sandbox = isSandboxMode()
  try {
    while (_groupNameBacklog.size) {
      const [key, item] = _groupNameBacklog.entries().next().value
      _groupNameBacklog.delete(key)
      const { selfId, pureId } = item
      const sep = Bot[selfId]?.adapter?.sep || ":"
      const fullId = `${selfId}${sep}${pureId}` // 与 QQBot-Plugin 标准一致：gl key 为 selfId:groupOpenid
      // glMap / exist 提升到 try 外，供 catch 标记 kicked 时使用
      const glMap = Bot[selfId]?.gl
      let exist = glMap ? (await glMap.get(fullId)) || {} : {}
      try {
        // 读取同样用 fullId（对齐 QQBot-Plugin 的 setGroupMap / getGroupMap）
        // 已退出群/非群成员(groupInvalid 群状态异常)的群跳过补取，避免反复请求
        if (!exist?.group_name && !exist?.name && !exist?.kicked && !exist?.groupInvalid) {
          // 沙箱模式：getGroupInfo 受限，跳过自动拉取（仅使用 gl 已有名称）
          if (sandbox) {
            await new Promise((r) => setTimeout(r, _GROUP_NAME_INTERVAL))
            continue
          }
          // 复用 QQBot-Plugin 官方 SDK 的 getGroupInfo（按 group_openid 获取）
          const sdk = Bot[selfId]?.sdk || Bot[selfId]
          if (sdk?.getGroupInfo) {
            // group_openid 为空（QQ 机器人事件偶发缺失）时不调接口，避免 404 报错；该群仍保留在列表
            if (!pureId) {
              await new Promise((r) => setTimeout(r, _GROUP_NAME_INTERVAL))
              continue
            }
            const gi = await sdk.getGroupInfo(pureId)
            const name = gi?.group_name || gi?.groupName || gi?.name || ""
            if (name && glMap) {
              // 写回格式对齐 QQBot-Plugin 的 setGroupMap：key=fullId，字段含 group_id/group_name
              const merged = { ...exist, group_id: fullId, group_openid: pureId, group_name: name, group_member_num: gi?.group_member_num || exist?.group_member_num }
              if (typeof glMap.set === "function") glMap.set(fullId, merged)
              else glMap[fullId] = merged
              logger.info(`[QQBot-Web] 群名补取成功 ${fullId} -> ${name}`)
              // 推送群名更新，前端自动刷新显示
              wsBroadcastAll(selfId, { type: "group_name_updated", groupId: fullId, group_name: name })
            }
          }
        }
      } catch (err) {
        // 机器人非群成员（11293）等鉴权失败：标记 kicked，避免反复补取
        const msg = String(err?.message || err || "")
        if (/11293|非群成员|鉴权失败|kicked/.test(msg)) {
          if (glMap) {
            const merged = { ...exist, group_id: fullId, group_openid: pureId, kicked: true }
            if (typeof glMap.set === "function") glMap.set(fullId, merged)
            else glMap[fullId] = merged
            logger.info(`[QQBot-Web] 群 ${fullId} 已退出/非群成员，标记 kicked，停止补取`)
          }
        } else if (/1125[0-9]|invalid request/i.test(msg)) {
          // invalid request（如 11255）：群状态异常（已解散 / 被封禁 / 类型不支持等），
          // 服务端对该 OpenID 调 info 持续拒绝。在 gl 中标记 groupInvalid 持久化，
          // 下次启动仍跳过补取，避免反复重试刷日志
          if (glMap) {
            const merged = { ...exist, group_id: fullId, group_openid: pureId, groupInvalid: true }
            if (typeof glMap.set === "function") glMap.set(fullId, merged)
            else glMap[fullId] = merged
            logger.warn(`[QQBot-Web] 群 ${fullId} getGroupInfo 返回 invalid request（群状态异常，已标记 groupInvalid 永久停止补取）: ${msg}`)
          }
        } else {
          logger.warn(`[QQBot-Web] 群名补取 getGroupInfo(${pureId}) 失败: ${msg}`)
        }
      }
      await new Promise((r) => setTimeout(r, _GROUP_NAME_INTERVAL))
    }
  } finally {
    _groupNameConsumerRunning = false
  }
}

async function getGroupName(selfId, rawId) {
  const glMap = Bot[selfId]?.gl
  if (!glMap) return rawId
  const sep = Bot[selfId]?.adapter?.sep || ":"
  const pureId = getPureGroupId(selfId, rawId)
  // 与 QQBot-Plugin 标准一致：gl key 为 selfId:groupOpenid
  const fullId = `${selfId}${sep}${pureId}`
  const info = await glMap.get(fullId) || await glMap.get(rawId)
  if (info?.kicked) return rawId // 已退出/非群成员，不再尝试补取
  if (info?.groupInvalid) return rawId // 群状态异常（解散/封禁），不再尝试补取
  if (info?.group_name) return info.group_name
  if (info?.name) return info.name
  // gl 中暂无名称：先返回兜底 id 让前端立即显示，再异步补取
  _groupNameEnqueue(selfId, pureId)
  return rawId
}

/** 获取 Bot 活跃群列表（统一为 selfId:groupOpenid 格式并去重） */
async function getGroups(selfId) {
  const sep = Bot[selfId]?.adapter?.sep || ":"
  // SQLite 路径
  if (config.storageBackend === "sqlite" && Bot.ActiveListDB) {
    try {
      const raw = await Bot.ActiveListDB.getList("active-group", selfId, 500)
      const seen = new Set()
      const tasks = []
      for (const rawId of raw) {
        const fullId = rawId.startsWith(`${selfId}${sep}`) ? rawId : `${selfId}${sep}${rawId}`
        if (seen.has(fullId)) continue
        seen.add(fullId)
        tasks.push((async () => ({ group_id: fullId, group_name: await getGroupName(selfId, rawId) }))())
      }
      return await Promise.all(tasks)
    } catch (err) {
      logger.error("[QQBot-Web] SQLite 获取群列表失败:", err)
      return []
    }
  }

  // 原有 Redis 路径
  try {
    const raw = await redis.zRange(`wind-active-group:${selfId}`, 0, -1)
    raw.reverse()
    const seen = new Set()
    const tasks = []
    for (const rawId of raw) {
      const fullId = rawId.startsWith(`${selfId}${sep}`) ? rawId : `${selfId}${sep}${rawId}`
      if (seen.has(fullId)) continue
      seen.add(fullId)
      tasks.push((async () => ({
        group_id: fullId,
        group_name: await getGroupName(selfId, rawId),
      }))())
    }
    return await Promise.all(tasks)
  } catch (err) {
    logger.error("[QQBot-Web] 获取群列表失败:", err)
    return []
  }
}

/** 获取 Bot 全量群列表（从 Bot.quanliangMap） */
async function getQuanliangGroups(selfId) {
  try {
    if (!Bot.quanliangMap) Bot.quanliangMap = new Map()
    const set = Bot.quanliangMap.get(selfId)
    if (!set || !set.size) return []
    const sep = Bot[selfId]?.adapter?.sep || ":"
    const tasks = []
    for (const rawId of set) {
      const fullId = rawId.startsWith(`${selfId}${sep}`) ? rawId : `${selfId}${sep}${rawId}`
      tasks.push((async () => ({
        group_id: fullId,
        group_name: await getGroupName(selfId, rawId),
      }))())
    }
    return await Promise.all(tasks)
  } catch (err) {
    logger.error("[QQBot-Web] 获取全量群列表失败:", err)
    return []
  }
}

/** 从 before 参数中提取时间戳（支持 _sort/msg_idx/timestamp/number/null） */
function extractBeforeTs(before) {
  if (!before) return 0
  if (typeof before === 'number') return before
  if (typeof before === 'object') return (before.timestamp || 0)
  return 0
}

/** 批量查询 need_audit 消息的最新审核状态 */
async function refreshAuditStatus(messages) {
  const needAudit = messages.filter(m => m.need_audit && m.audit_id)
  if (!needAudit.length) return
  try {
    const seenAudit = new Set()
    const pending = []
    for (const m of needAudit) {
      if (m.audit_status === "passed" || m.audit_status === "rejected") continue
      if (seenAudit.has(m.audit_id)) continue
      seenAudit.add(m.audit_id)
      pending.push(m)
    }
    if (!pending.length) return
    const results = await Promise.all(
      pending.map(m => redis.get(`wind-audit-message_id:${m.audit_id}`).catch(() => null))
    )
    for (let i = 0; i < pending.length; i++) {
      const msg = pending[i]
      try {
        const val = results[i]
        if (val) {
          const ar = JSON.parse(val)
          if (ar.success && ar.id) { msg.message_id = ar.id; msg.audit_status = "passed" }
          else if (ar.success === false) { msg.audit_status = "rejected" }
          else { msg.audit_status = "pending" }
        } else { msg.audit_status = "pending" }
      } catch { msg.audit_status = "pending" }
    }
    // 同步到共享相同 audit_id 但被去重跳过的消息
    for (const m of needAudit) {
      if (m.audit_status) continue
      const src = pending.find(p => p.audit_id === m.audit_id)
      if (src?.audit_status) {
        m.audit_status = src.audit_status
        if (src.message_id) m.message_id = src.message_id
      }
    }
  } catch (err) {
    logger.error("[QQBot-Web] 查询审核状态失败:", err)
  }
}

/** 获取群聊消息（兼容两种 group_id 格式的 key） */
async function getMessages(selfId, groupId, before, limit = 20, baseUrl = '') {
  // SQLite 存储路径
  if (config.storageBackend === "sqlite" && Bot.MessageDB) {
    try {
      const pureId = getPureGroupId(selfId, groupId)
      const beforeTs = extractBeforeTs(before)
      // SQL 层分页：倒序取最新 limit 条，再反转为升序展示
      const pageMessages = await Bot.MessageDB.getByGroups([groupId, pureId], beforeTs, limit, true)
      pageMessages.reverse() // DESC → ASC 供前端按时间升序渲染
      // 修复 at 位置
      for (const msg of pageMessages) fixAtPositions(msg)
      // 补齐 ref_msg_idx
      for (const msg of pageMessages) {
        if (!msg.ref_msg_idx && Array.isArray(msg.message)) {
          for (const seg of msg.message) {
            if (seg.type === "reply" && seg.id) { msg.ref_msg_idx = seg.id; break }
          }
        }
      }
      // 填充引用摘要
      const refMsgIdxs = pageMessages.filter(m => m.ref_msg_idx && !m.ref_summary).map(m => m.ref_msg_idx)
      if (refMsgIdxs.length > 0) {
        const summaries = await getRefMsgSummaries(selfId, groupId, refMsgIdxs)
        for (const msg of pageMessages) {
          if (msg.ref_msg_idx && !msg.ref_summary) {
            if (summaries[msg.ref_msg_idx]) { msg.ref_summary = summaries[msg.ref_msg_idx] }
            else {
              const fallback = extractRefFromMsgElements(msg.raw_event, selfId)
              if (fallback) { msg.ref_summary = fallback }
              else { msg.ref_summary = refSummaryPlaceholder(msg.ref_msg_idx) }
            }
          }
        }
      }
      // 设置 _sort 供前端翻页回传
      pageMessages.forEach((m, i) => { m._sort = i })
      resolveLocalSegments(pageMessages, selfId, baseUrl)
      return pageMessages
    } catch (err) {
      logger.error("[QQBot-Web] SQLite 获取消息失败:", err)
      return []
    }
  }

  // 原有 Redis 路径
  const allMessages = []

  // incoming 消息总以完整格式存储
  const userKey = `wind-msg:group:${groupId}`
  // bot 消息以纯 groupOpenid 存储（adapter 内部 sendGroupMsg 使用 data.group_id）
  const pureId = getPureGroupId(selfId, groupId)
  const botKey = `wind-bot-msg:group:${pureId}`
  // 同时也查一下完整格式的 bot key（兼容）
  const botKeyFull = `wind-bot-msg:group:${groupId}`

  try {
    // 用范围查询代替全量拉取，大幅减少传输和反序列化
    const fetchCount = limit + 10  // 多取几条容错跨 key 去重
    const beforeTs = extractBeforeTs(before)
    let userRaw, botRawAll, botRawFullAll

    if (beforeTs) {
      // 翻页：取 beforeTs 之前的最近 fetchCount 条（倒序，新的在前）
      const max = `(${beforeTs}`  // 左开区间
      const countStr = String(fetchCount)
      ;[userRaw, botRawAll, botRawFullAll] = await Promise.all([
        redis.sendCommand(['ZREVRANGEBYSCORE', userKey, max, '-inf', 'LIMIT', '0', countStr]),
        redis.sendCommand(['ZREVRANGEBYSCORE', botKey, max, '-inf', 'LIMIT', '0', countStr]),
        botKey !== botKeyFull ? redis.sendCommand(['ZREVRANGEBYSCORE', botKeyFull, max, '-inf', 'LIMIT', '0', countStr]) : Promise.resolve([])
      ])
    } else {
      // 首页：取每个 key 的最后 fetchCount 条，反转得到倒序（新的在前）
      ;[userRaw, botRawAll, botRawFullAll] = await Promise.all([
        redis.zRange(userKey, -fetchCount, -1),
        redis.zRange(botKey, -fetchCount, -1),
        botKey !== botKeyFull ? redis.zRange(botKeyFull, -fetchCount, -1) : Promise.resolve([])
      ])
      // zRange 返回 ASC，手动反转为 DESC
      userRaw.reverse()
      botRawAll.reverse()
      if (botRawFullAll.length) botRawFullAll.reverse()
    }
    // 此时所有 raw 均已按时间倒序（新的在前）

    const seen = new Set()

    for (const raw of userRaw) {
      try {
        const m = JSON.parse(raw)
        const uid = m.msg_idx || m.message_id || (m.timestamp + "_" + m.user_id)
        if (!seen.has(uid)) {
          seen.add(uid)
          allMessages.push(m)
        }
      } catch {}
    }
    for (const raws of [botRawAll, botRawFullAll]) {
      for (const raw of raws) {
        try {
          const m = JSON.parse(raw)
          m.me = true
          const uid = m.msg_idx || m.message_id || (m.timestamp + "_" + m.user_id)
          if (!seen.has(uid)) {
            seen.add(uid)
            allMessages.push(m)
          }
        } catch {}
      }
    }

    // 按时间戳升序（方便 fixAtPositions / ref 填充按时间顺序处理）
    allMessages.sort((a, b) => {
      let ta = a.timestamp || 0
      let tb = b.timestamp || 0
      if (ta < 1000000000000) ta *= 1000
      if (tb < 1000000000000) tb *= 1000
      return ta - tb
    })

    // 只保留最新的 limit 条（预处理前就截断，减少后续 fixAtPositions 等开销）
    allMessages.splice(0, Math.max(0, allMessages.length - limit))

    // 批量查询 need_audit 消息的审核状态
    await refreshAuditStatus(allMessages)

    // 修复 [@username] at 位置（底层库删除 [@xxx] 并将 at 段追加到末尾）
    for (const msg of allMessages) fixAtPositions(msg)

    // 为没有 ref_msg_idx 但 message 数组中有 reply segment 的消息补齐 ref_msg_idx
    for (const msg of allMessages) {
      if (!msg.ref_msg_idx && Array.isArray(msg.message)) {
        for (const seg of msg.message) {
          if (seg.type === "reply" && seg.id) {
            msg.ref_msg_idx = seg.id
            break
          }
        }
      }
    }

    // 批量填充引用消息摘要
    const refMsgIdxs = allMessages
      .filter(m => m.ref_msg_idx && !m.ref_summary)
      .map(m => m.ref_msg_idx)
    if (refMsgIdxs.length > 0) {
      const summaries = await getRefMsgSummaries(selfId, groupId, refMsgIdxs)
      for (const msg of allMessages) {
        if (msg.ref_msg_idx && !msg.ref_summary) {
          if (summaries[msg.ref_msg_idx]) {
            msg.ref_summary = summaries[msg.ref_msg_idx]
          } else {
            const fallback = extractRefFromMsgElements(msg.raw_event, selfId)
            if (fallback) { msg.ref_summary = fallback }
            else { msg.ref_summary = refSummaryPlaceholder(msg.ref_msg_idx) }
          }
        }
      }
    }

    allMessages.forEach((m, i) => { m._sort = i })
    resolveLocalSegments(allMessages, selfId, baseUrl)
    return allMessages
  } catch (err) {
    logger.error("[QQBot-Web] 获取消息失败:", err)
    return []
  }
}

/**
 * 通过 msg_idx 从消息 ZSET 中查找消息的 raw_event
 * 注：raw_event 随消息一起存储在 wind-msg:group:{groupId}/wind-bot-msg:group:{groupId} 中
 *     wind-msg-idx:{msgIdx} 仅存 msg_idx→msg_id 映射（用于撤回），不含 raw_event
 */
async function getRawMessage(selfId, groupId, msgIdx) {
  // SQLite 路径
  if (config.storageBackend === "sqlite" && Bot.MessageDB) {
    try { return await Bot.MessageDB.getRawEvent(msgIdx) } catch { return null }
  }

  // 原有 Redis 路径
  try {
    const pureId = getPureGroupId(selfId, groupId)
    const keys = [
      `wind-msg:group:${groupId}`,
      `wind-bot-msg:group:${pureId}`,
      `wind-bot-msg:group:${groupId}`
    ]

    for (const keyName of keys) {
      const msgs = await redis.zRange(keyName, 0, -1)
      msgs.reverse()
      for (const raw of msgs) {
        try {
          const m = JSON.parse(raw)
          if (m.msg_idx === msgIdx) {
            return m.raw_event || null
          }
        } catch {}
      }
    }
    return null
  } catch (err) {
    logger.error("[QQBot-Web] 获取原始消息失败:", err)
    return null
  }
}

// 引用摘要内存缓存：{ selfId → Map<msg_idx, {nickname, summary, ...}> }
const refSummaryCacheMap = new Map()
function ensureRefSummaryCache(selfId) {
  if (!refSummaryCacheMap.has(selfId)) refSummaryCacheMap.set(selfId, new Map())
  return refSummaryCacheMap.get(selfId)
}

/**
 * 批量查询 ref_msg_idx 对应的消息摘要（发送者昵称 + 内容前100字）
 * 用于在消息列表中显示引用条
 * @param {string} selfId
 * @param {string|null} groupId - 群消息时传入 groupId，私聊时传 null
 * @param {string[]} refMsgIdxs
 */
async function getRefMsgSummaries(selfId, groupId, refMsgIdxs) {
  if (!Array.isArray(refMsgIdxs) || !refMsgIdxs.length) return {}
  const result = {}

  // SQLite 路径
  if (config.storageBackend === "sqlite" && Bot.MsgIdxDB) {
    const flMap = Bot[selfId]?.fl
    const sep = Bot[selfId]?.adapter?.sep || ":"
    for (const idx of refMsgIdxs) {
      try {
        const info = await Bot.MsgIdxDB.findByMsgIdx(idx)
        if (info) {
          const uid = info.self_id || ""
          const isMe = uid === String(selfId)
          let nickname = uid
          if (flMap instanceof Map) {
            const pureUid = uid.includes(sep) ? uid.split(sep).pop() : uid
            const flInfo = flMap.get(uid) || flMap.get(pureUid) || flMap.get(`${selfId}${sep}${pureUid}`)
            if (flInfo?.nickname) nickname = flInfo.nickname
          }
          result[idx] = { nickname: nickname || "未知", summary: "", msg_idx: idx, user_id: uid || "", me: isMe }
        }
      } catch {}
    }
    return result
  }

  let keys = []
  if (groupId) {
    const pureId = getPureGroupId(selfId, groupId)
    keys = [
      `wind-msg:group:${groupId}`,
      `wind-bot-msg:group:${pureId}`,
      `wind-bot-msg:group:${groupId}`
    ]
  } else {
    // 私聊：从 wind-msg-idx:{msgIdx} 获取 user_id，再从 fl 和 ZSET 中查昵称与内容
    const flMap = Bot[selfId]?.fl
    const sep = Bot[selfId]?.adapter?.sep || ":"
    for (const idx of refMsgIdxs) {
      try {
        const idxKey = `wind-msg-idx:${idx}`
        const raw = await redis.get(idxKey)
        if (raw) {
          const info = JSON.parse(raw)
          const uid = info.self_id || ""
          const chatUid = info.user_id || uid
          // 是否是 bot 自己发的消息
          const isMe = uid === String(selfId)
          // 从 fl Map 中查找真实昵称
          let nickname = uid
          if (flMap instanceof Map) {
            const pureUid = uid.includes(sep) ? uid.split(sep).pop() : uid
            const flInfo = flMap.get(uid) || flMap.get(pureUid) || flMap.get(`${selfId}${sep}${pureUid}`)
            if (flInfo?.nickname) nickname = flInfo.nickname
          }
          // 尝试从私聊 ZSET 中查找消息内容作为摘要（最近500条）
          // 同时按 self_id 和 user_id（聊天对象ID）查询两套 key
          let summary = ""
          try {
            const candidateIds = [uid]
            if (chatUid && chatUid !== uid) candidateIds.push(chatUid)
            for (const lookupId of candidateIds) {
              if (summary) break
              const userKey = `wind-msg:private:${lookupId}`
              const botKey = `wind-bot-msg:private:${lookupId}`
              const [userRaw, botRaw] = await Promise.all([
                redis.zRange(userKey, -500, -1),
                redis.zRange(botKey, -500, -1),
              ])
              const userEntries = Array.isArray(userRaw) ? [...userRaw].reverse() : []
              const botEntries = Array.isArray(botRaw) ? [...botRaw].reverse() : []
              for (const entries of [userEntries, botEntries]) {
                if (summary) break
                for (const entry of entries) {
                  try {
                    const m = JSON.parse(entry)
                    if (String(m.msg_idx) === String(idx)) {
                      if (m.raw_message) {
                        summary = typeof m.raw_message === "string"
                          ? m.raw_message
                          : (Array.isArray(m.raw_message) ? m.raw_message.map(s => s.text || "").join("") : "")
                      } else if (Array.isArray(m.message)) {
                        summary = m.message.map(s => s.text || "").join("")
                      }
                      // 如果 fl 没查到昵称，用消息中存储的
                      if (nickname === uid && m.nickname) nickname = m.nickname
                      break
                    }
                  } catch {}
                }
              }
            }
          } catch (e) { logger.error(`[QQBot-Web] getRefMsgSummaries ZSET查找出错:`, e) }
          result[idx] = {
            nickname: nickname || "未知",
            summary: (summary || "").slice(0, 100),
            msg_idx: idx,
            user_id: uid || "",
            me: isMe,
          }
        } else {
          logger.warn(`[QQBot-Web] idx=${idx}: wind-msg-idx 未找到!`)
        }
      } catch (e) { logger.error(`[QQBot-Web] getRefMsgSummaries 处理 idx=${idx} 出错:`, e) }
    }
    return result
  }

  try {
    // 先用内存缓存命中已知摘要
    const refSummaryCache = ensureRefSummaryCache(selfId)
    const idxSet = new Set(refMsgIdxs)
    const found = new Set()
    for (const idx of refMsgIdxs) {
      const cached = refSummaryCache.get(idx)
      if (cached) {
        result[idx] = cached
        found.add(idx)
      }
    }

    // 未命中的只查最近 500 条（引用消息基本都是近期的）
    const needLookup = refMsgIdxs.filter(idx => !found.has(idx))
    if (needLookup.length > 0) {
      const allRaw = await Promise.all(keys.map(k => redis.zRange(k, -500, -1).catch(() => [])))
      for (const raws of allRaw) {
        for (const raw of raws) {
          if (found.size >= idxSet.size) break
          try {
            const m = JSON.parse(raw)
            if (m.msg_idx && idxSet.has(m.msg_idx) && !found.has(m.msg_idx)) {
              found.add(m.msg_idx)
              let summary = ""
              if (m.raw_message) {
                summary = m.raw_message
              } else if (Array.isArray(m.message)) {
                summary = m.message.map(s => s.text || "").join("")
              }
              const item = {
                nickname: m.nickname || "未知",
                summary: (summary || "").slice(0, 100),
                msg_idx: m.msg_idx,
                user_id: m.user_id || "",
                me: m.me || false,
              }
              result[m.msg_idx] = item
              refSummaryCache.set(m.msg_idx, item)
            }
          } catch {}
        }
        if (found.size >= idxSet.size) break
      }
    }
  } catch (err) {
    logger.error("[QQBot-Web] 批量查询引用摘要失败:", err)
  }

  return result
}

/**
 * 从 raw_event.d.msg_elements 中提取被引用消息的信息
 * 当 Redis 中找不到 ref_msg_idx 对应消息时的降级方案
 * @param {object} rawEvent - 原始事件的 raw_event
 * @param {string} selfId - Bot 的 self_id
 * @returns {object|null} ref_summary 对象或 null
 */
function extractRefFromMsgElements(rawEvent, selfId) {
  try {
    const msgElements = rawEvent?.d?.msg_elements
    if (!Array.isArray(msgElements) || !msgElements.length) return null

    const elem = msgElements[0]
    const author = elem.author || {}
    const content = elem.content || ""
    const attachments = Array.isArray(elem.attachments) ? elem.attachments : []

    let summary = content
    if (!summary) summary = ""

    const result = {
      nickname: author.username || "未知",
      summary: summary.slice(0, 100),
      msg_idx: elem.msg_idx || "",
      user_id: author.id || author.member_openid || "",
      me: author.bot === true,
      is_bot: author.bot === true,
      source: "fallback", // 标记为降级引用，前端用淡红色显示
    }

    // 将被引用消息中的富媒体附件传递给前端，用于在引用条中渲染缩略图
    if (attachments.length > 0) {
      result.fallback_attachments = attachments.map(a => ({
        url: a.url || "",
        content_type: a.content_type || a.type || "",
        width: a.width || 0,
        height: a.height || 0,
      }))
    }

    return result
  } catch {
    return null
  }
}

/**
 * 引用消息摘要占位符：当 Redis 和 raw_event 都查不到被引用消息时使用
 * 让前端知道这是一条引用回复，但原文已不可获得
 */
function refSummaryPlaceholder(refMsgIdx) {
  return {
    nickname: "无法获取",
    summary: "",
    msg_idx: refMsgIdx,
    user_id: "",
    me: false,
    placeholder: true,
    source: "fallback",
  }
}

/**
 * 从 Bot.fl 中为消息补齐缺失的昵称和头像
 */
const patchNicknameFromFl = (() => {
  const _cache = new Map() // selfId -> flLookup
  const getLookup = (selfId) => {
    let lookup = _cache.get(selfId)
    if (!lookup) {
      const flMap = Bot[selfId]?.fl
      const sep = Bot[selfId]?.adapter?.sep || ":"
      if (!(flMap instanceof Map)) return null
      lookup = (uid) => {
        let info = flMap.get(uid) || flMap.get(`${selfId}${sep}${uid}`)
        if (!info && uid.includes(sep)) info = flMap.get(uid.split(sep).pop())
        return info
      }
      _cache.set(selfId, lookup)
    }
    return lookup
  }
  return (selfId, msg) => {
    const uid = msg.user_id || ""
    if (!uid) return
    // 昵称为空/缺失、退化为 user_id、或被存为"未知"时，从 fl 补充
    if (!msg.nickname || msg.nickname === uid || msg.nickname === "未知") {
      const fn = getLookup(selfId)
      if (fn) {
        const flInfo = fn(uid)
        if (flInfo?.nickname) {
          msg.nickname = flInfo.nickname
          if (!msg.avatar && flInfo.avatar) msg.avatar = flInfo.avatar
        }
      }
    }
  }
})()

/**
 * 确保消息中 _local: true 的媒体 segment 保留 _local 标记和 file 相对路径。
 * 前端 getMediaUrl 通过 seg._local 检测本地缓存，localUrlMap 通过 seg.url(CDN)
 * → getMediaUrl(file) 映射 CDN URL 到 local-media 端点，完成显示和预览的替换。
 * 注意：不修改 seg.url（前端需要 CDN URL 做 key 进行映射）也不删除 _local。
 */
function resolveLocalSegments(_messages, _selfId, _baseUrl = '') {
  // 当前数据流中 SDK 已设置 _local + file，前端通过 localUrlMap 自行映射 CDN→local
  // 保留此函数作为扩展点，未来如需服务端预处理 URL 可在此加入
}

/** 消息段规范化：过滤 face、清洗文本标签、标准化 markdown 格式 */
const CLEAN_TAG_REGEX = /<(faceType|attachmentType)=[^>]*>/g
function normalizeMessageSegment(seg) {
  if (seg.type === "face") return null
  let normalized = { ...seg }
  if (seg.type === "text" && typeof seg.text === "string") {
    normalized.text = seg.text.replace(CLEAN_TAG_REGEX, "")
    if (!normalized.text) return null
  }
  if (seg.type === "markdown" && !seg.data && seg.content) {
    normalized = { type: "markdown", data: { content: seg.content } }
  }
  return normalized
}

/** 发送群消息 */
async function sendGroupMessage(selfId, groupId, msgConfig) {
  const bot = Bot[selfId]
  if (!bot) return { success: false, error: "Bot 未连接" }

  const adapter = bot.adapter
  if (!adapter) return { success: false, error: "适配器未找到" }

  // 从完整 group_id 中提取纯群号
  let rawGroupId = groupId
  const sep = adapter.sep || ":"
  if (groupId.startsWith(`${selfId}${sep}`)) {
    rawGroupId = groupId.slice(selfId.length + sep.length)
  }

  const msgType = msgConfig.msgType || "legacy"
  const data = {
    self_id: selfId,
    bot: bot,
    group_id: rawGroupId,
    platform: "QQ-group",
    legacy: msgType === "legacy" || msgType === "media",
  }

  // 构建消息段：规范化 + at 昵称补全 + 媒体 base64→Buffer（URL 原样保留不下载）
  const buildSegments = async (segs) => {
    const cleaned = []
    for (const rawSeg of segs) {
      const seg = normalizeMessageSegment(rawSeg)
      if (!seg) continue
      // 为 at 段补全 nickname：如果没传 nickname/name，从 Bot.fl 查找
      if (seg.type === "at" && !seg.nickname && !seg.name) {
        const flMap = bot.fl
        if (flMap instanceof Map) {
          const qqVal = seg.qq || ""
          const pureUid = qqVal.includes(sep) ? qqVal.split(sep).pop() : qqVal
          let info = flMap.get(pureUid) || flMap.get(qqVal)
          if (!info) info = flMap.get(`${selfId}${sep}${pureUid}`)
          if (info?.nickname) seg.nickname = info.nickname
        }
      }
      cleaned.push(seg)
    }
    const mediaTypes = ["image", "video", "record", "file", "audio"]
    const items = await Promise.all(cleaned.map(async seg => {
      if (mediaTypes.includes(seg.type) && seg.file) {
        // 真 Buffer → 直接传递
        if (Buffer.isBuffer(seg.file))
          return segment[seg.type](seg.file, seg.fileName || seg.name)
        // JSON 序列化的 Buffer { type:'Buffer', data:[...] } → 还原
        if (seg.file.type === "Buffer" && Array.isArray(seg.file.data))
          return segment[seg.type](Buffer.from(seg.file.data), seg.fileName || seg.name)
        // 字符串路径
        if (typeof seg.file === "string") {
          // base64 data URL → 解码为 Buffer
          if (seg.file.startsWith("data:") || /^[A-Za-z0-9+/]{100,}={0,2}$/.test(seg.file)) {
            const b64 = seg.file.includes(",") ? seg.file.split(",")[1] : seg.file
            const buf = Buffer.from(b64, "base64")
            return segment[seg.type](buf, seg.fileName || seg.name)
          }
          // local-media URL → 提取 path 参数，读本地 Buffer（绕开 HTTP 鉴权）
          if (seg.file.includes("/local-media?path=")) {
            const resolved = await resolveLocalFile(seg.file)
            if (resolved)
              return segment[seg.type](resolved.buf, seg.fileName || seg.name || resolved.name)
            return null
          }
          if (seg.file.startsWith("http://") || seg.file.startsWith("https://"))
            return segment[seg.type](seg.file, seg.fileName || seg.name)
          // 本地文件 → 读 Buffer，绕开 HTTP 鉴权
          const resolved = await resolveLocalFile(seg.file)
          if (resolved)
            return segment[seg.type](resolved.buf, seg.fileName || seg.name || resolved.name)
          return null
        }
      }
      return seg
    }))
    return items.filter(Boolean)
  }

  let message = msgConfig.segments ? await buildSegments(msgConfig.segments) : []

  // 引用回复：将 msg_idx 作为 reply 段嵌入消息开头
  if (msgConfig.reply_msg_idx) {
    message = [{ type: "reply", id: msgConfig.reply_msg_idx }, ...message]
  }

  // 构建 source 对象，用于传递 msg_id 或 event_id（被动消息回复）
  const source = {}
  if (msgConfig.reply_event_id) {
    source.event_id = msgConfig.reply_event_id
  } else if (msgConfig.reply_msg_id) {
    source.id = msgConfig.reply_msg_id
  }

  try {
    const ret = await adapter.sendGroupMsg(data, message, source)
    // 判断是否为审核消息：SDK 返回的 id 以 msg_auditid_ 开头即为 audit_id
    const rawMsgId = ret?.message_id?.[0] || ""
    const isAudit = String(rawMsgId).startsWith("msg_auditid_")
    const auditId = isAudit ? rawMsgId : null
    const realMsgId = isAudit ? null : rawMsgId

    // 发送错误处理
    if (ret?.error?.length) {
      return { success: false, error: ret.error.map(e => e?.message || String(e)).join("; ") }
    }

    // 推送给 WebSocket 客户端（bot 自己的消息）
    if (!ret?.error?.length) {
      wsBroadcast(selfId, groupId, {
        type: "bot_message_sent",
        groupId,
        message_id: realMsgId,
        audit_id: auditId,
        message_type: msgType,
      })
    }

    return { ...ret, message_id: realMsgId, audit_id: auditId }
  } catch (err) {
    logger.error("[QQBot-Web] 发送消息失败:", err)
    return { success: false, error: String(err) }
  }
}

/** 获取私聊消息 */
async function getPrivateMessages(selfId, userId, before, limit = 20, baseUrl = '') {
  // SQLite 存储路径
  if (config.storageBackend === "sqlite" && Bot.MessageDB) {
    try {
      const beforeTs = extractBeforeTs(before)
      // SQL 层分页：倒序取最新 limit 条，再反转为升序展示
      const pageMessages = await Bot.MessageDB.getByPrivate(userId, beforeTs, limit, true)
      pageMessages.reverse()
      // 修复 at 位置 + 补齐昵称
      for (const msg of pageMessages) { fixAtPositions(msg); patchNicknameFromFl(selfId, msg) }
      // 补齐 ref_msg_idx
      for (const msg of pageMessages) {
        if (!msg.ref_msg_idx && Array.isArray(msg.message)) {
          for (const seg of msg.message) {
            if (seg.type === "reply" && seg.id) { msg.ref_msg_idx = seg.id; break }
          }
        }
      }
      // 填充引用摘要
      const refMsgIdxs = pageMessages.filter(m => m.ref_msg_idx && !m.ref_summary).map(m => m.ref_msg_idx)
      if (refMsgIdxs.length > 0) {
        const summaries = await getRefMsgSummaries(selfId, null, refMsgIdxs)
        for (const msg of pageMessages) {
          if (msg.ref_msg_idx && !msg.ref_summary) {
            if (summaries[msg.ref_msg_idx]) { msg.ref_summary = summaries[msg.ref_msg_idx] }
            else { msg.ref_summary = refSummaryPlaceholder(msg.ref_msg_idx) }
          }
        }
      }
      pageMessages.forEach((m, i) => { m._sort = i })
      resolveLocalSegments(pageMessages, selfId, baseUrl)
      return pageMessages
    } catch (err) {
      logger.error("[QQBot-Web] SQLite 获取私聊消息失败:", err)
      return []
    }
  }

  // 原有 Redis 路径
  const allMessages = []

  const userKey = `wind-msg:private:${userId}`
  const botKey = `wind-bot-msg:private:${userId}`

  try {
    // 用范围查询代替全量拉取
    const fetchCount = limit + 10
    const beforeTs = extractBeforeTs(before)
    let userRaw, botRaw

    if (beforeTs) {
      const max = `(${beforeTs}`
      const countStr = String(fetchCount)
      ;[userRaw, botRaw] = await Promise.all([
        redis.sendCommand(['ZREVRANGEBYSCORE', userKey, max, '-inf', 'LIMIT', '0', countStr]),
        redis.sendCommand(['ZREVRANGEBYSCORE', botKey, max, '-inf', 'LIMIT', '0', countStr]),
      ])
    } else {
      ;[userRaw, botRaw] = await Promise.all([
        redis.zRange(userKey, -fetchCount, -1),
        redis.zRange(botKey, -fetchCount, -1),
      ])
      userRaw.reverse()
      botRaw.reverse()
    }

    const seen = new Set()
    for (const raw of [...botRaw, ...userRaw]) {
      try {
        const m = JSON.parse(raw)
        const uid = m.msg_idx || m.message_id || (m.timestamp + "_" + m.user_id)
        if (!seen.has(uid)) {
          seen.add(uid)
          allMessages.push(m)
        }
      } catch {}
    }

    allMessages.sort((a, b) => {
      let ta = a.timestamp || 0
      let tb = b.timestamp || 0
      if (ta < 1000000000000) ta *= 1000
      if (tb < 1000000000000) tb *= 1000
      return ta - tb
    })

    // 只保留最新的 limit 条
    allMessages.splice(0, Math.max(0, allMessages.length - limit))

    // 修复 [@username] at 位置
    for (const msg of allMessages) fixAtPositions(msg)

    // 私聊消息：从 fl 补齐缺失的昵称
    for (const msg of allMessages) patchNicknameFromFl(selfId, msg)

    // 为没有 ref_msg_idx 但 message 数组中有 reply segment 的消息补齐 ref_msg_idx
    for (const msg of allMessages) {
      if (!msg.ref_msg_idx && Array.isArray(msg.message)) {
        for (const seg of msg.message) {
          if (seg.type === "reply" && seg.id) {
            msg.ref_msg_idx = seg.id
            break
          }
        }
      }
    }

    // 批量填充引用消息摘要
    const refMsgIdxs = allMessages
      .filter(m => m.ref_msg_idx && !m.ref_summary)
      .map(m => m.ref_msg_idx)
    if (refMsgIdxs.length > 0) {
      const summaries = await getRefMsgSummaries(selfId, null, refMsgIdxs)
      for (const msg of allMessages) {
        if (msg.ref_msg_idx && !msg.ref_summary) {
          if (summaries[msg.ref_msg_idx]) {
            msg.ref_summary = summaries[msg.ref_msg_idx]
          } else {
            msg.ref_summary = refSummaryPlaceholder(msg.ref_msg_idx)
          }
        }
      }
    }

    allMessages.forEach((m, i) => { m._sort = i })
    resolveLocalSegments(allMessages, selfId, baseUrl)
    return allMessages
  } catch (err) {
    logger.error("[QQBot-Web] 获取私聊消息失败:", err)
    return []
  }
}

/** 获取私聊原始消息 */
async function getRawPrivateMessage(selfId, userId, msgIdx) {
  // SQLite 路径
  if (config.storageBackend === "sqlite" && Bot.MessageDB) {
    try { return await Bot.MessageDB.getRawEvent(msgIdx) } catch { return null }
  }

  // 原有 Redis 路径
  try {
    const keys = [
      `wind-msg:private:${userId}`,
      `wind-bot-msg:private:${userId}`,
    ]
    for (const keyName of keys) {
      const msgs = await redis.zRange(keyName, 0, -1)
      msgs.reverse()
      for (const raw of msgs) {
        try {
          const m = JSON.parse(raw)
          if (m.msg_idx === msgIdx) {
            return m.raw_event || null
          }
        } catch {}
      }
    }
    return null
  } catch {
    return null
  }
}

/** 发送私聊消息 */
async function sendPrivateMessage(selfId, userId, msgConfig) {
  const bot = Bot[selfId]
  if (!bot) return { success: false, error: "Bot 未连接" }

  const adapter = bot.adapter
  if (!adapter) return { success: false, error: "适配器未找到" }

  const sep = adapter.sep || ":"
  const pureOpenid = userId.startsWith(`${selfId}${sep}`) ? userId.slice(selfId.length + sep.length) : userId

  const msgType = msgConfig.msgType || "legacy"
  const data = {
    self_id: selfId,
    bot: bot,
    user_id: pureOpenid,
    platform: "QQ-private",
    legacy: msgType === "legacy" || msgType === "media",
  }

  // 构建消息段：规范化 + 媒体 → Buffer（本地文件直接读取，HTTP URL 原样保留）
  const buildSegments = async (segs) => {
    const mediaTypes = ["image", "video", "record", "file", "audio"]
    const items = await Promise.all(segs.map(async seg => {
      const normalized = normalizeMessageSegment(seg)
      if (!normalized) return null
      if (mediaTypes.includes(normalized.type) && normalized.file) {
        if (Buffer.isBuffer(normalized.file))
          return segment[normalized.type](normalized.file, normalized.fileName || normalized.name)
        if (normalized.file.type === "Buffer" && Array.isArray(normalized.file.data))
          return segment[normalized.type](Buffer.from(normalized.file.data), normalized.fileName || normalized.name)
        if (typeof normalized.file === "string") {
          // base64 data URL → 解码为 Buffer
          if (normalized.file.startsWith("data:") || /^[A-Za-z0-9+/]{100,}={0,2}$/.test(normalized.file)) {
            const b64 = normalized.file.includes(",") ? normalized.file.split(",")[1] : normalized.file
            const buf = Buffer.from(b64, "base64")
            return segment[normalized.type](buf, normalized.fileName || normalized.name)
          }
          // local-media URL → 提取 path 参数，读本地 Buffer（绕开 HTTP 鉴权）
          if (normalized.file.includes("/local-media?path=")) {
            const resolved = await resolveLocalFile(normalized.file)
            if (resolved)
              return segment[normalized.type](resolved.buf, normalized.fileName || normalized.name || resolved.name)
            return null
          }
          if (normalized.file.startsWith("http://") || normalized.file.startsWith("https://"))
            return segment[normalized.type](normalized.file, normalized.fileName || normalized.name)
          const resolved = await resolveLocalFile(normalized.file)
          if (resolved)
            return segment[normalized.type](resolved.buf, normalized.fileName || normalized.name || resolved.name)
          return null
        }
      }
      return normalized
    }))
    return items.filter(Boolean)
  }

  let message = msgConfig.segments ? await buildSegments(msgConfig.segments) : []

  // 引用回复：将 msg_idx 作为 reply 段嵌入消息开头
  if (msgConfig.reply_msg_idx) {
    message = [{ type: "reply", id: msgConfig.reply_msg_idx }, ...message]
  }

  // 构建 source 对象，用于传递 msg_id 或 event_id（被动消息回复）
  const source = {}
  if (msgConfig.reply_event_id) {
    source.event_id = msgConfig.reply_event_id
  } else if (msgConfig.reply_msg_id) {
    source.id = msgConfig.reply_msg_id
  }

  try {
    const ret = await adapter.sendFriendMsg(data, message, source)
    const rawMsgId = ret?.message_id?.[0] || ""
    const isAudit = String(rawMsgId).startsWith("msg_auditid_")
    const auditId = isAudit ? rawMsgId : null
    const realMsgId = isAudit ? null : rawMsgId

    // 发送错误处理
    if (ret?.error?.length) {
      return { success: false, error: ret.error.map(e => e?.message || String(e)).join("; ") }
    }

    if (!ret?.error?.length) {
      wsBroadcastPrivate(selfId, userId, {
        type: "bot_message_sent",
        privateUserId: userId,
        message_id: realMsgId,
        audit_id: auditId,
        message_type: msgType,
      })
    }

    return { ...ret, message_id: realMsgId, audit_id: auditId }
  } catch (err) {
    logger.error("[QQBot-Web] 发送私聊消息失败:", err)
    return { success: false, error: String(err) }
  }
}

// 静态文件目录
const webDir = path.join(__dirname, "web")

// 根路径重定向到 WEB_BASE，确保前端 BASE 计算正确
Bot.express.get(["/", "/login.html"], (req, res) => {
  res.redirect(301, req.path === "/" ? `${WEB_BASE}/` : `${WEB_BASE}/login.html`)
})

// favicon.ico（浏览器自动请求，走 basePath 前缀）
Bot.express.get(`${WEB_BASE}/favicon.ico`, (req, res) => {
  const faviconPath = path.join(webDir, "favicon.ico")
  res.set("Cache-Control", "public, max-age=86400")
  res.sendFile(faviconPath, err => { if (err) res.status(404).end() })
})

// 频率限制中间件（在鉴权之前）
Bot.express.use(`${WEB_BASE}/api`, rateLimitMiddleware(RATELIMIT_MAX, RATELIMIT_LOGIN_MAX))

// 安全响应头中间件（所有请求）
Bot.express.use(`${WEB_BASE}`, (req, res, next) => {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  }
  // 自定义页面通过同源 iframe 加载，需允许被框架嵌入（其余保持 DENY 防点击劫持）
  if (req.path.startsWith("/api/web-page/")) {
    headers["X-Frame-Options"] = "SAMEORIGIN"
  } else {
    headers["X-Frame-Options"] = "DENY"
  }
  res.set(headers)
  next()
})

// 公网访问控制中间件（仅在内网模式下拦截非内网 IP）
Bot.express.use(`${WEB_BASE}`, (req, res, next) => {
  if (config.publicAccess === true) return next()
  // 放行 health 检查
  if (req.path === "/api/health") return next()
  const ip = getClientIp(req)
  if (!isPrivateIp(ip)) {
    return res.status(403).json({ error: "公网访问已关闭，请通过内网访问控制台" })
  }
  next()
})

// API 响应：禁止缓存 + 错误信息脱敏
Bot.express.use(`${WEB_BASE}/api`, (req, res, next) => {
  // 禁止缓存敏感 API 响应
  res.set("Cache-Control", "no-cache, no-store, must-revalidate")
  res.set("Pragma", "no-cache")

  // 包装 res.json 对 500 错误脱敏
  const origJson = res.json.bind(res)
  res.json = function (body) {
    if (res.statusCode === 500 && body && typeof body.error === "string" && body.error) {
      logger.debug(`[QQBot-Web] API 内部错误 (${req.method} ${req.path}):`, body.error)
      body = { ...body, error: "服务器内部错误，请查看日志" }
    }
    return origJson(body)
  }
  next()
})

// 鉴权中间件（在静态文件之前）
Bot.express.use(`${WEB_BASE}`, async (req, res, next) => {
  const relativePath = req.path

  // 不鉴权的路径
  if (relativePath === "/api/login" || relativePath === "/api/logout") return next()
  if (relativePath === "/api/login/captcha") return next()
  if (relativePath === "/api/login/status") return next()
  if (relativePath === "/login.html") return next()

  // 登录开关关闭时直接放行
  if (config.login?.enabled === false) return next()

  // 已登录 → 放行
  if (await getSession(req)) return next()

  // 未登录
  if (relativePath.startsWith("/api/")) {
    return res.status(401).json({ error: "未登录" })
  }

  // 页面请求 → 重定向到登录页（302 避免登录页 URL 被写入浏览器历史）
  res.set("Cache-Control", "no-cache, no-store, must-revalidate")
  res.redirect(`${WEB_BASE}/login.html`)
})

// ========== 媒体文件端点（鉴权之后，<img> 同源请求自动带 cookie） ==========

// 图片代理（QQ CDN → 本地反代，避免防盗链）
// 仅允许白名单内的 QQ CDN 域名，防止 SSRF
const IMAGE_PROXY_ALLOWED_HOSTS = [
  "gchat.qpic.cn", "c2cpicdw.qpic.cn", "chat.qpic.cn",
  "multimedia.nt.qq.com.cn", "multimedia.nt.qq.com",
  "groupprohead.gtimg.cn", "thirdqq.qlogo.cn", "qlogo.cn",
  "qpic.cn", "qq.com", "gtimg.cn", "qlogo.cn",
]
Bot.express.get(`${WEB_BASE}/api/bot/:selfId/image-proxy`, async (req, res) => {
  try {
    const url = req.query.url
    if (!url) return res.status(400).end("missing url")

    // SSRF 防护：检查 URL 域名是否在白名单内
    let parsedUrl
    try {
      parsedUrl = new URL(url)
    } catch {
      return res.status(400).end("invalid url")
    }
    const hostname = parsedUrl.hostname.toLowerCase()
    const allowed = IMAGE_PROXY_ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith("." + h))
    if (!allowed) return res.status(403).end("host not allowed")

    const buf = await Bot.Buffer(url, { http: true })
    let contentType = "image/jpeg"
    const extMatch = url.match(/\.(\w+)(?:\?|$)/i)
    if (extMatch) {
      const ext = extMatch[1].toLowerCase()
      const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" }
      if (mimeMap[ext]) contentType = mimeMap[ext]
    }
    res.set("Content-Type", contentType)
    res.set("Content-Length", buf.length)
    res.set("Cache-Control", "public, max-age=86400")
    res.send(buf)
  } catch (err) {
    logger.debug(`[QQBot-Web] image-proxy 失败: ${err.message}`)
    res.status(502).end()
  }
})

// 本地媒体文件服务（bot 发送的图片/视频等 Buffer 转为本地文件后通过此端点拉取）
// 严格限制：仅允许 data/imgs/ 目录
Bot.express.get(`${WEB_BASE}/api/bot/:selfId/local-media`, async (req, res) => {
  try {
    const rawRel = req.query.path
    if (!rawRel) return res.status(400).end("invalid path")

    // 解码并拒绝任何目录穿越 / 绝对路径
    let rel
    try { rel = decodeURIComponent(rawRel).split(/[?#]/)[0] } catch { return res.status(400).end("invalid path") }
    let relNorm
    try { relNorm = path.normalize(rel) } catch { return res.status(400).end("invalid path") }
    if (relNorm === "" || relNorm.startsWith("/") || relNorm.startsWith("\\") || relNorm.split(/[\\/]/).includes("..")) {
      return res.status(403).end("forbidden")
    }

    // 安全检查：严格限制仅允许访问 data/imgs/ 目录
    const pluginDir = path.join(path.dirname(__dirname), "QQBot-Plugin")
    const imgsDir = path.join(pluginDir, "data", "imgs")
    // saveMediaFile 返回的路径已包含 data/imgs/ 前缀，需剥离后再拼接
    const mediaPrefix = `data${path.sep}imgs${path.sep}`
    if (relNorm.startsWith(mediaPrefix)) relNorm = relNorm.slice(mediaPrefix.length)
    const filePath = path.join(imgsDir, relNorm)

    if (filePath !== imgsDir && !filePath.startsWith(imgsDir + path.sep)) return res.status(403).end("forbidden")

    // 检查文件是否存在
    await fs.access(filePath)

    const ext = path.extname(filePath).toLowerCase()
    const mimeMap = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
      '.mp4': 'video/mp4', '.webm': 'video/webm',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    }
    const contentType = mimeMap[ext] || 'application/octet-stream'
    res.set('Content-Type', contentType)
    res.set('Cache-Control', 'public, max-age=86400')
    res.sendFile(filePath)
  } catch (err) {
    logger.debug(`[QQBot-Web] local-media 失败: ${err.message}`)
    res.status(404).end()
  }
})

// 静态文件目录重定向：/qqbot-web → /qqbot-web/
Bot.express.use(`${WEB_BASE}`, (req, res, next) => {
  if (req.path.startsWith("/api/")) return next()
  if (req.path === "/" && !req.originalUrl.endsWith("/")) {
    return res.redirect(301, `${WEB_BASE}/`)
  }
  next()
})

// 静态文件服务（express.static 自动处理 MIME 类型 + 304 条件请求）
Bot.express.use(`${WEB_BASE}`, express.static(webDir, {
  setHeaders(res) {
    res.set("Cache-Control", "no-cache, no-store, must-revalidate")
  }
}))

// SPA fallback：非文件请求返回 index.html（CSS/JS 等扩展名明确的资源 404 则透传）
Bot.express.use(`${WEB_BASE}`, (req, res, next) => {
  if (req.path.startsWith("/api/")) return next()

  const ext = path.extname(req.path).toLowerCase()
  if (ext && ext !== ".html") return next()

  res.set("Cache-Control", "no-cache, no-store, must-revalidate")
  res.sendFile(path.join(webDir, "index.html"), err => {
    if (err) res.sendStatus(404)
  })
})

// 健康检查
Bot.express.get(`${WEB_BASE}/api/health`, (req, res) => {
  res.json({ ok: true, time: Date.now() })
})

// 自定义页面：列表（仅返回前端渲染所需元数据）
Bot.express.get(`${WEB_BASE}/api/web-pages`, (req, res) => {
  const list = Bot.webAdapter.getPages().map(p => ({
    id: p.id, title: p.title, icon: p.icon, type: p.type, priority: p.priority,
    src: p.src, html: p.html, style: p.style, script: p.script,
  }))
  res.json({ pages: list })
})

// 自定义页面：插件 webadapter/ 下的静态资源（受全局鉴权保护）
// 用正则捕获 plugin 与后续相对路径，兼容 Express 4/5（避免 * 通配差异）
// 安全：严格防目录穿越 + 后缀白名单，禁止读到插件 webadapter/ 之外或其它文件
const webPageRe = new RegExp('^' + WEB_BASE.replace(/[.+*?^${}()|[\]\\]/g, '\\$&') + '/api/web-page/([^/]+)/(.*)$')
Bot.express.get(webPageRe, (req, res) => {
  // 自定义页面不缓存，避免沙盒等页面 JS 更新后浏览器仍执行旧版本
  res.set("Cache-Control", "no-store")
  const rawPlugin = req.params[0]
  const rawRel = req.params[1] || ""

  // 1) plugin 段必须是合法目录名（解码后仍需匹配，禁止 ../、编码穿越、绝对路径）
  let plugin
  try { plugin = decodeURIComponent(rawPlugin) } catch { return res.sendStatus(400) }
  if (!/^[\w.-]+$/.test(plugin) || plugin === "." || plugin === "..") return res.sendStatus(400)

  // 2) rel 解码，禁止查询串/片段混入与目录穿越
  let rel
  try { rel = decodeURIComponent(rawRel).split(/[?#]/)[0] } catch { return res.sendStatus(400) }
  rel = rel.replace(/^\/+/, "")

  // 3) 规范化为相对路径，显式拒绝任何 .. / 绝对段 / 空路径
  let relNorm
  try { relNorm = path.normalize(rel) } catch { return res.sendStatus(400) }
  if (relNorm === "" || relNorm.startsWith("/") || relNorm.startsWith("\\") || relNorm.split(/[\\/]/).includes("..")) {
    return res.sendStatus(403)
  }

  // 3.5) 白名单校验：只允许访问该插件声明过的 src/style/script 文件，
  //      或落在已声明资源目录（如 public）内的任意文件，其余一律拒绝
  const allowed = webPageAllowed.get(plugin)
  const topDir = relNorm.split(/[\\/]/)[0]
  const inAssets = webPageAssets.get(plugin)?.has(topDir) || false
  if ((!allowed || !allowed.has(relNorm)) && !inAssets) return res.sendStatus(403)

  // 4) 用 path.join 强制拼接（会自动再次规范化），并校验严格落在插件 webadapter 目录内
  const base = path.join(pluginsRoot, plugin, "webadapter")
  const filePath = path.join(base, relNorm)
  if (filePath !== base && !filePath.startsWith(base + path.sep)) return res.sendStatus(403)

  // 5) 后缀白名单
  const ext = path.extname(filePath).toLowerCase()
  const extAllowed = [".html", ".js", ".css", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".map"]
  if (!extAllowed.includes(ext)) return res.sendStatus(403)

  res.sendFile(filePath, err => { if (err) res.sendStatus(404) })
})

// 登录
Bot.express.post(`${WEB_BASE}/api/login`, async (req, res) => {
  try {
    const ip = getClientIp(req)
    const { username, password, captcha } = req.body || {}
    if (!username || !password) return res.status(400).json({ error: "用户名和密码不能为空" })

    // 设备标识（持久 Cookie，用于识别可信设备；新设备无 Cookie 时用 IP 兜底）
    let deviceId = getDeviceId(req)
    const deviceKey = deviceId || `ip:${ip}`

    // 1. 检查设备级封禁（该设备输错 5 次后被永久封禁，需验证码解封）
    let isDeviceBlocked = false
    try { isDeviceBlocked = !!(await redis.get(`${REDIS_BLOCKED_PREFIX}${deviceKey}`)) } catch {}

    // 2. 检查是否为新设备（无设备 Cookie 或设备未登记）
    let isNewDevice = false
    if (!isDeviceBlocked && deviceId) {
      try { isNewDevice = !(await redis.sIsMember(`${REDIS_DEVICE_PREFIX}${username}`, deviceId)) } catch { isNewDevice = true }
    } else if (!deviceId) {
      isNewDevice = true  // 无设备 Cookie → 新设备
    }

    const needCaptcha = isDeviceBlocked || isNewDevice

    if (needCaptcha) {
      if (!captcha) {
        return res.status(401).json({
          error: isDeviceBlocked ? "登录失败次数过多，需要输入验证码" : "新设备登录，需要输入验证码",
          requireCaptcha: true
        })
      }
      // 校验验证码
      let captchaOk = false
      try {
        const stored = await redis.get(`${REDIS_CAPTCHA_PREFIX}${ip}`)
        if (stored && stored === String(captcha).trim()) captchaOk = true
      } catch {}
      if (!captchaOk) {
        return res.status(401).json({ error: "验证码错误或已过期，请重新获取", requireCaptcha: true })
      }
      // 验证通过立即删除验证码，防止重用
      try {
        await redis.del(`${REDIS_CAPTCHA_PREFIX}${ip}`)
        await redis.del(`${REDIS_CAPTCHA_TIME_PREFIX}${ip}`)
      } catch {}
    }

    // 校验用户名密码
    if (username !== (config.login?.username || "admin") || password !== (config.login?.password || "admin123")) {
      // 登录失败：累计设备级失败次数
      try {
        const newCount = await redis.incr(`${REDIS_ATTEMPTS_PREFIX}${deviceKey}`)
        await redis.expire(`${REDIS_ATTEMPTS_PREFIX}${deviceKey}`, LOGIN_ATTEMPTS_TTL)
        // 第 3 次失败时推送通知
        if (newCount === 3 || newCount === 4 || newCount === LOGIN_FAIL_THRESHOLD) {
          notifyLoginFailure(ip, username, newCount)
        }
        if (newCount >= LOGIN_FAIL_THRESHOLD) {
          // 设备级永久封禁
          await redis.set(`${REDIS_BLOCKED_PREFIX}${deviceKey}`, "1")
          return res.status(401).json({ error: "登录失败次数过多，该设备已被限制，需要输入验证码", requireCaptcha: true })
        }
        return res.status(401).json({ error: `用户名或密码错误（剩余尝试 ${LOGIN_FAIL_THRESHOLD - newCount} 次）` })
      } catch {
        return res.status(401).json({ error: "用户名或密码错误" })
      }
    }

    // 登录成功
    try {
      // 清除设备级失败计数和封禁
      await redis.del(`${REDIS_ATTEMPTS_PREFIX}${deviceKey}`)
      if (captcha && isDeviceBlocked) {
        await redis.del(`${REDIS_BLOCKED_PREFIX}${deviceKey}`)
      }
      // 清除 IP 级验证码
      await redis.del(`${REDIS_CAPTCHA_PREFIX}${ip}`)
      await redis.del(`${REDIS_CAPTCHA_TIME_PREFIX}${ip}`)
    } catch {}

    // 注册设备：登录成功后登记为可信设备
    if (!deviceId) {
      deviceId = crypto.randomUUID()
    }
    try {
      await redis.sAdd(`${REDIS_DEVICE_PREFIX}${username}`, deviceId)
    } catch {}

    const token = genToken()
    await setSession(token, username)
    res.cookie("qqbot_session", token, {
      httpOnly: true,
      secure: req.secure || req.protocol === "https",
      sameSite: "lax",
      maxAge: SESSION_TTL * 1000,
      path: "/",
    })
    // 设备 Cookie（1年有效期）
    res.cookie(DEVICE_COOKIE, deviceId, {
      httpOnly: true,
      secure: req.secure || req.protocol === "https",
      sameSite: "lax",
      maxAge: DEVICE_TTL * 1000,
      path: "/",
    })
    res.json({ ok: true, username })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 查询是否需要验证码（供前端预检，避免新设备多一次请求往返）
Bot.express.get(`${WEB_BASE}/api/login/status`, async (req, res) => {
  try {
    const deviceId = getDeviceId(req)
    const username = config.login?.username || "admin"
    let needCaptcha = true
    if (deviceId) {
      try {
        const ip = getClientIp(req)
        const deviceKey = deviceId || `ip:${ip}`
        const isBlocked = !!(await redis.get(`${REDIS_BLOCKED_PREFIX}${deviceKey}`))
        const isKnown = isBlocked ? false : !!(await redis.sIsMember(`${REDIS_DEVICE_PREFIX}${username}`, deviceId))
        needCaptcha = !isKnown
      } catch {}
    }
    res.json({ needCaptcha })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 向通知用户发送验证码（如果已设置）
async function notifyCaptchaCode(type, code) {
  const notifyId = config.notifyUserId?.trim()
  if (!notifyId) return
  try {
    let targetBotId = null
    let resolvedUserId = notifyId
    if (Bot.uin?.length > 0) {
      for (const id of Bot.uin) {
        if (!Bot[id]?.adapter) continue
        if (Bot[id].fl?.has?.(notifyId)) {
          targetBotId = id
          break
        }
        const sep = Bot[id].adapter.sep
        if (sep) {
          const lookupKey = `${id}${sep}${notifyId}`
          if (Bot[id].fl?.has?.(lookupKey)) {
            targetBotId = id
            resolvedUserId = lookupKey
            break
          }
        }
      }
    }
    if (targetBotId) {
      const typeLabel = type === "login" ? "登录验证码" : "设置变更验证码"
      const msg = `【${typeLabel}】\n\`\`\`\n${code}\n\`\`\`\n有效期 3 分钟`
      await Bot.sendFriendMsg(targetBotId, resolvedUserId, msg)
    }
  } catch {}
}

// 发送登录验证码
Bot.express.post(`${WEB_BASE}/api/login/captcha`, async (req, res) => {
  try {
    const ip = getClientIp(req)

    // 检查发送间隔
    try {
      const cooldown = await redis.get(`${REDIS_CAPTCHA_TIME_PREFIX}${ip}`)
      if (cooldown) {
        const remaining = await redis.ttl(`${REDIS_CAPTCHA_TIME_PREFIX}${ip}`)
        return res.status(429).json({ error: `请等待 ${remaining} 秒后再获取验证码`, cooldown: remaining })
      }
    } catch {}

    // 生成32位字母数字混合验证码
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
    let code = ''
    for (let i = 0; i < 32; i++) {
      code += chars[Math.floor(Math.random() * chars.length)]
    }

    // 存入 Redis
    try {
      await redis.setEx(`${REDIS_CAPTCHA_PREFIX}${ip}`, LOGIN_CAPTCHA_TTL, code)
      await redis.setEx(`${REDIS_CAPTCHA_TIME_PREFIX}${ip}`, LOGIN_CAPTCHA_COOLDOWN, "1")
    } catch {}

    // 输出到控制台
    logger.info("=".repeat(40))
    logger.info(`[登录验证码] 请求来自: ${ip}`)
    logger.info(`[登录验证码] 验证码: ${code}`)
    logger.info(`[登录验证码] 有效期: ${LOGIN_CAPTCHA_TTL / 60} 分钟`)
    logger.info("=".repeat(40))

    // 同时发送给通知用户
    notifyCaptchaCode("login", code)

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 登出
Bot.express.post(`${WEB_BASE}/api/logout`, async (req, res) => {
  try {
    const token = getSessionToken(req)
    if (token) await deleteSession(token)
    res.clearCookie("qqbot_session", { path: "/" })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 获取 Bot 列表
Bot.express.get(`${WEB_BASE}/api/bots`, (req, res) => {
  try {
    const bots = getBots()
    res.json(bots)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 当前选中的 Bot 完整信息（基于进程内存 selectedSelfId）
// 注册为 webadapter 接口，路径：GET /api/bot/current
// 同时已暴露 Bot.webAdapter.getCurrentBot() 供其它自定义页面直接调用
Bot.webAdapter.registerApi("get", "/bot/current", (req, res) => {
  try {
    const sid = getSelectedSelfId()
    const bot = getCurrentBot()
    res.json({ ok: true, selectedSelfId: sid, bot, bots: getBots() })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// 停止某 Bot 的 SDK 连接（不删除配置）
function stopBotSdk(id) {
  const b = Bot[id]
  if (!b) return
  try { b.logout?.() } catch {}
  try { b.sdk?.stop?.() } catch {}
}

// 从全局 Bot 注册表中移除某 Bot（仅内存，不改配置文件）
function removeBotFromGlobal(id) {
  try {
    if (Array.isArray(Bot.uin)) {
      const i = Bot.uin.indexOf(id)
      if (i >= 0) Bot.uin.splice(i, 1)
    }
  } catch {}
  try { delete Bot[id] } catch {}
}

// 启用（重新连接）某 Bot：优先复用已存在实例，否则用配置文件中的 token 热连接
async function enableBotById(id) {
  const uinStr = String(id)
  const cfg = await readQQBotConfig()
  const tok = (cfg.token || []).find(t => String(t?.QQ) === uinStr)
  if (!tok) throw new Error("配置文件中找不到该 Bot 的 token")
  const t = normalizeToken(tok)
  // saveAndConnectBot 会更新配置并热连接（已存在实例则重启 sdk）
  const r = await saveAndConnectBot(uinStr, t.appid, t.secret, t.webhook ? "2" : "1", t.private ? "1" : "0")
  if (Bot[uinStr]) Bot[uinStr]._webDisabled = false
  return r
}

// 关闭（停用）某 Bot：停止 SDK，保留配置，标记内存禁用
Bot.express.post(`${WEB_BASE}/api/bot/:selfId/disable`, async (req, res) => {
  try {
    const { selfId } = req.params
    if (!Bot[selfId]) return res.status(404).json({ error: "Bot 未找到" })
    stopBotSdk(selfId)
    Bot[selfId]._webDisabled = true
    logger.mark(`[QQBot-Web] Bot ${selfId} 已关闭`)
    res.json({ ok: true })
  } catch (err) {
    logger.error("[QQBot-Web] 关闭 Bot 失败:", err)
    res.status(500).json({ error: String(err) })
  }
})

// 启用（重新连接）某 Bot
Bot.express.post(`${WEB_BASE}/api/bot/:selfId/enable`, async (req, res) => {
  try {
    const { selfId } = req.params
    await enableBotById(selfId)
    logger.mark(`[QQBot-Web] Bot ${selfId} 已启用`)
    res.json({ ok: true })
  } catch (err) {
    logger.error("[QQBot-Web] 启用 Bot 失败:", err)
    res.status(500).json({ error: String(err) })
  }
})

// 删除某 Bot：停止连接、从配置文件移除 token、从全局注册表移除
Bot.express.post(`${WEB_BASE}/api/bot/:selfId/delete`, async (req, res) => {
  try {
    const { selfId } = req.params
    if (!Bot[selfId]) return res.status(404).json({ error: "Bot 未找到" })

    stopBotSdk(selfId)
    removeBotFromGlobal(selfId)

    // 从 QQBot.yaml 配置文件中移除对应 token
    const cfg = await readQQBotConfig()
    if (Array.isArray(cfg.token)) {
      cfg.token = cfg.token.filter(t => String(t?.QQ) !== String(selfId))
      await writeQQBotConfig(cfg)
    }
    logger.mark(`[QQBot-Web] Bot ${selfId} 已删除（配置与内存均已移除）`)
    res.json({ ok: true })
  } catch (err) {
    logger.error("[QQBot-Web] 删除 Bot 失败:", err)
    res.status(500).json({ error: String(err) })
  }
})

// 获取某 Bot 的置顶数据（群聊 + 私信），按当前配置的存储后端读取
Bot.express.get(`${WEB_BASE}/api/pins`, async (req, res) => {
  try {
    const selfId = req.query.bot
    if (!selfId) return res.status(400).json({ error: "缺少 bot 参数" })
    const groups = await getPins(String(selfId), "groups")
    const priv = await getPins(String(selfId), "private")
    res.json({ groups, private: priv, backend: currentPinBackend() })
  } catch (err) {
    logger.error("[QQBot-Web] 置顶读取接口错误:", err)
    res.status(500).json({ error: String(err) })
  }
})

// 写入某 Bot 的置顶数据（群聊或私信）
Bot.express.post(`${WEB_BASE}/api/pins`, async (req, res) => {
  try {
    const { bot, kind, ids } = req.body || {}
    if (!bot) return res.status(400).json({ error: "缺少 bot 参数" })
    if (kind !== "groups" && kind !== "private") return res.status(400).json({ error: "kind 非法" })
    if (!Array.isArray(ids)) return res.status(400).json({ error: "ids 必须为数组" })
    await setPins(String(bot), kind, ids.map(String))
    res.json({ ok: true, backend: currentPinBackend() })
  } catch (err) {
    logger.error("[QQBot-Web] 置顶写入接口错误:", err)
    res.status(500).json({ error: String(err) })
  }
})

// 获取 Bot 群列表（支持 ?type=active|quanliang）
Bot.express.get(`${WEB_BASE}/api/bot/:selfId/groups`, async (req, res) => {
  try {
    const { selfId } = req.params
    const type = req.query.type || "active"
    if (!Bot[selfId]) return res.status(404).json({ error: "Bot 未找到" })
    const groups = type === "quanliang"
      ? await getQuanliangGroups(selfId)
      : await getGroups(selfId)
    // 注入黑名单状态
    for (const g of groups) g.is_blacklisted = isGroupBlacklisted(g.group_id)
    res.json(groups)
  } catch (err) {
    logger.error("[QQBot-Web] 群列表接口错误:", err)
    res.status(500).json({ error: String(err) })
  }
})

// 获取群详细信息（群信息弹窗）：直接调官方 SDK getGroupInfo，返回完整群资料并写回 gl
Bot.express.get(`${WEB_BASE}/api/bot/:selfId/group/:groupId/info`, async (req, res) => {
  try {
    const { selfId, groupId } = req.params
    if (!Bot[selfId]) return res.status(404).json({ error: "Bot 未找到" })
    const pureId = getPureGroupId(selfId, groupId)
    const sep = Bot[selfId]?.adapter?.sep || ":"
    const fullId = `${selfId}${sep}${pureId}`
    const glMap = Bot[selfId]?.gl
    // 优先从 gl 读取已有资料
    let info = glMap ? (await glMap.get(fullId)) || {} : {}
    const recordedMemberNum = info?.group_member_num ?? info?.member_count ?? 0 // gl 中记录的人数
    if (!info?.kicked) {
      const sdk = Bot[selfId]?.sdk || Bot[selfId]
      if (sdk?.getGroupInfo && !isSandboxMode()) {
        // group_openid 为空（QQ 机器人事件偶发缺失）时不调接口，避免 404 报错；直接用已有 gl 数据返回
        if (!pureId) {
          logger.debug(`[QQBot-Web] 群 ${fullId} group_openid 为空，跳过 getGroupInfo`)
        } else {
          try {
            const gi = await sdk.getGroupInfo(pureId)
            info = {
              group_openid: gi?.group_openid || pureId,
              group_name: gi?.group_name || gi?.groupName || gi?.name || info?.group_name || "",
              group_finger_memo: gi?.group_finger_memo || gi?.fingerMemo || "",
              group_class_text: gi?.group_class_text || gi?.classText || "",
              group_tags: gi?.group_tags || [],
              group_member_num: gi?.group_member_num ?? gi?.memberNum ?? info?.group_member_num ?? 0,
            }
            // 写回 gl，对齐 setGroupMap 标准（key=fullId）
            if (glMap) {
              const prev = (await glMap.get(fullId)) || {}
              const merged = { ...prev, ...info, group_id: fullId }
              if (typeof glMap.set === "function") glMap.set(fullId, merged)
              else glMap[fullId] = merged
              // 群名有变化则推送，前端自动刷新群列表显示
              if (merged.group_name && merged.group_name !== prev.group_name) {
                wsBroadcastAll(selfId, { type: "group_name_updated", groupId: fullId, group_name: merged.group_name })
              }
            }
          } catch (err) {
            const msg = String(err?.message || err || "")
            if (/11293|非群成员|鉴权失败|kicked/.test(msg)) {
              if (glMap) {
                const merged = { ...(await glMap.get(fullId) || {}), group_id: fullId, group_openid: pureId, kicked: true }
                if (typeof glMap.set === "function") glMap.set(fullId, merged)
                else glMap[fullId] = merged
              }
              return res.status(404).json({ error: "机器人非群成员，无法获取群信息", kicked: true })
            } else if (/1125[0-9]|invalid request/i.test(msg)) {
              // 群状态异常（解散/封禁/类型不支持）：标记 groupInvalid 持久化，下次不再补取
              if (glMap) {
                const merged = { ...(await glMap.get(fullId) || {}), group_id: fullId, group_openid: pureId, groupInvalid: true }
                if (typeof glMap.set === "function") glMap.set(fullId, merged)
                else glMap[fullId] = merged
              }
              logger.warn(`[QQBot-Web] 群详情 getGroupInfo(${pureId}) 返回 invalid request（群状态异常，已标记 groupInvalid）: ${msg}`)
              return res.status(410).json({ error: "该群状态异常（可能已解散/被封禁），无法获取群信息", groupInvalid: true })
            }
            logger.warn(`[QQBot-Web] 群详情 getGroupInfo(${pureId}) 失败: ${msg}`)
          }
        }
      }
    }
    // 群备注（wind-group-name 哈希）
    let note = ""
    try {
      note = (await redis.hGet("wind-group-name", groupId)) || (await redis.hGet("wind-group-name", pureId)) || ""
    } catch { /* ignore */ }
    res.json({
      group_openid: info.group_openid || pureId,
      group_name: info.group_name || "",
      group_finger_memo: info.group_finger_memo || "",
      group_class_text: info.group_class_text || "",
      group_tags: info.group_tags || [],
      group_member_num: info.group_member_num || 0,
      recorded_member_num: recordedMemberNum || 0,
      note: note || "",
    })
  } catch (err) {
    logger.error("[QQBot-Web] 群详情接口错误:", err)
    res.status(500).json({ error: String(err) })
  }
})

// 获取群消息
Bot.express.get(`${WEB_BASE}/api/bot/:selfId/group/:groupId/messages`, async (req, res) => {
  try {
    const { selfId, groupId } = req.params
    // before 支持两种格式：
    //   1. 纯数字 timestamp（兼容旧版）
    //   2. JSON 对象 { msg_idx, timestamp }（新版，优先用 msg_idx 精确定位）
    let before = 0
    const beforeRaw = req.query.before
    if (beforeRaw) {
      try {
        const parsed = JSON.parse(beforeRaw)
        if (parsed && typeof parsed === "object") {
          before = parsed
        } else {
          before = parseInt(beforeRaw) || 0
        }
      } catch {
        before = parseInt(beforeRaw) || 0
      }
    }
    const limit = Math.min(parseInt(req.query.limit) || 20, 100)
    const baseUrl = `${req.protocol}://${req.get('host')}`
    const messages = await getMessages(selfId, groupId, before, limit, baseUrl)
    res.json(messages)
  } catch (err) {
    logger.error("[QQBot-Web] 消息接口错误:", err)
    res.status(500).json({ error: String(err) })
  }
})

// 获取消息原始数据
Bot.express.get(`${WEB_BASE}/api/bot/:selfId/group/:groupId/message/raw`, async (req, res) => {
  try {
    const { selfId, groupId } = req.params
    const msgIdx = req.query.msg_idx
    if (!msgIdx) return res.status(400).json({ error: "缺少 msg_idx 参数" })
    const raw = await getRawMessage(selfId, groupId, msgIdx)
    if (raw) {
      res.json(raw)
    } else {
      res.status(404).json({ error: "消息未找到" })
    }
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** 解析二进制发送协议 Body（segments 中图片用 {img:N} 占位，后面跟随 blob 数据） */
function parseBinarySendBody(rawBuffer) {
  let offset = 0
  const jsonLen = rawBuffer.readUInt32LE(offset); offset += 4
  const jsonBytes = rawBuffer.subarray(offset, offset + jsonLen); offset += jsonLen
  const jsonStr = new TextDecoder().decode(jsonBytes)
  const payload = JSON.parse(jsonStr)
  const blobCount = rawBuffer.readUInt32LE(offset); offset += 4
  const blobs = []
  for (let i = 0; i < blobCount; i++) {
    const blobLen = rawBuffer.readUInt32LE(offset); offset += 4
    blobs.push(rawBuffer.subarray(offset, offset + blobLen))
    offset += blobLen
  }
  return { ...payload, blobs }
}

/** 从二进制协议或 JSON body 中解析消息配置（二进制时直接用 Buffer 替换占位符，图床上交由 adapter 完成） */
function resolveSendConfig(req) {
  if (req.headers["x-bin-protocol"] === "1" && Buffer.isBuffer(req.body)) {
    const { segments, reply_msg_idx, reply_msg_id, reply_event_id, blobs } = parseBinarySendBody(req.body)
    // 替换 {img:N} 占位符为 Buffer（适用于 image / video / record / audio / file 等所有媒体类型）
    const mediaTypes = new Set(["image", "video", "record", "audio", "file"])
    const resolved = segments.map(s => {
      if (mediaTypes.has(s.type) && typeof s.file === "string") {
        const m = s.file.match(/^\{img:(\d+)\}$/)
        if (m) {
          const idx = parseInt(m[1], 10)
          if (idx >= 0 && idx < blobs.length && blobs[idx]) return { ...s, file: blobs[idx] }
          return null
        }
      }
      return s
    }).filter(Boolean)
    return { segments: resolved, reply_msg_idx, reply_msg_id, reply_event_id }
  }
  // JSON 协议（兼容旧版）
  return { segments: req.body.segments, reply_msg_idx: req.body.reply_msg_idx, reply_msg_id: req.body.reply_msg_id, reply_event_id: req.body.reply_event_id }
}

const sendRawParser = express.raw({ type: "application/x-qqbot-bin", limit: "200mb" })

// 发送群消息
Bot.express.post(`${WEB_BASE}/api/bot/:selfId/group/:groupId/send`, sendRawParser, async (req, res) => {
  try {
    const { selfId, groupId } = req.params
    if (!Bot[selfId]) return res.status(404).json({ error: "Bot 未找到" })

    const msgType = req.headers["x-msg-type"] || "legacy"
    const baseUrl = `${req.protocol}://${req.get('host')}`
    const msgConfig = resolveSendConfig(req)
    const result = await sendGroupMessage(selfId, groupId, { ...msgConfig, msgType, baseUrl })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ===== 私聊 API =====

// 获取私聊用户列表
Bot.express.get(`${WEB_BASE}/api/bot/:selfId/private-chats`, async (req, res) => {
  try {
    const { selfId } = req.params
    if (!Bot[selfId]) return res.status(404).json({ error: "Bot 未找到" })

    const offset = Math.max(parseInt(req.query.offset) || 0, 0)
    const limit = Math.min(parseInt(req.query.limit) || 20, 100)

    const flMap = Bot[selfId]?.fl
    const sep = Bot[selfId]?.adapter?.sep || ":"
    const flLookup = (uid) => {
      if (!(flMap instanceof Map)) return null
      let info = flMap.get(uid) || flMap.get(`${selfId}${sep}${uid}`)
      if (!info && uid.includes(sep)) info = flMap.get(uid.split(sep).pop())
      return info
    }

    // 构建单个用户的详情（昵称/头像/openid/unionid），按需调用，避免一次拉全量
    const buildUser = async (uid) => {
      try {
        let nickname = null, avatar = "", openid = "", unionid = ""
        if (config.storageBackend === "sqlite" && Bot.MessageDB) {
          let row = await Bot.MessageDB.findOne({
            where: { user_id: uid, message_type: 'private', me: 0 },
            order: [['timestamp', 'DESC']],
          })
          if (!row) {
            row = await Bot.MessageDB.findOne({
              where: { user_id: uid, message_type: 'private' },
              order: [['timestamp', 'DESC']],
            })
          }
          if (row) {
            const m = Bot.MessageDB.unpack(row)
            nickname = m.nickname || null
            avatar = m.avatar || ""
            openid = m.openid || ""
            unionid = m.unionid || ""
          }
        } else {
          const msgKey = `wind-msg:private:${uid}`
          const msgRaw = await redis.zRange(msgKey, -1, -1)
          if (msgRaw && msgRaw.length > 0) {
            try {
              const msg = JSON.parse(msgRaw[0])
              nickname = msg.nickname || null
              avatar = msg.avatar || ""
              openid = msg.openid || ""
              unionid = msg.unionid || ""
            } catch {}
          }
        }
        const flInfo = flLookup(uid)
        if (flInfo?.nickname) { nickname = flInfo.nickname; if (!avatar && flInfo.avatar) avatar = flInfo.avatar }
        if (flInfo?.openid && !openid) openid = flInfo.openid
        if (flInfo?.unionid && !unionid) unionid = flInfo.unionid
        if (!nickname) nickname = uid
        return { user_id: String(uid), nickname, avatar, openid, unionid }
      } catch {
        return { user_id: String(uid), nickname: uid, avatar: "", openid: "", unionid: "" }
      }
    }

    // 完整的已排序 user_id 列表（按最后活跃时间倒序）
    let userIds = []
    try {
      if (config.storageBackend === "sqlite" && Bot.ActiveListDB) {
        userIds = await Bot.ActiveListDB.getList("active-private", selfId, 500)
      } else {
        const activeKey = `wind-active-private:${selfId}`
        const raw = await redis.zRange(activeKey, 0, -1)
        userIds = Array.isArray(raw) ? raw.reverse() : []
      }
    } catch {}

    // 置顶私聊优先：把置顶的 user_id 提到列表最前面（去重）
    try {
      const pins = await getPins(String(selfId), "private")
      const pinArr = Array.isArray(pins) ? pins.map(String) : []
      if (pinArr.length) {
        const pinSet = new Set(pinArr)
        const rest = userIds.filter(id => !pinSet.has(String(id)))
        userIds = [...pinArr.filter(id => userIds.some(x => String(x) === String(id))), ...rest]
      }
    } catch {}

    const total = userIds.length
    const pageIds = userIds.slice(offset, offset + limit)

    const users = []
    for (const uid of pageIds) {
      const u = await buildUser(uid)
      u.is_blacklisted = isUserBlacklisted(u.user_id, u.unionid)
      users.push(u)
    }

    res.json({ users, total, offset, limit, hasMore: offset + limit < total })
  } catch (err) {
    logger.error("[QQBot-Web] 获取私聊列表失败:", err)
    res.status(500).json({ error: String(err) })
  }
})

// 获取私聊消息
Bot.express.get(`${WEB_BASE}/api/bot/:selfId/private/:userId/messages`, async (req, res) => {
  try {
    const { selfId, userId } = req.params
    let before = 0
    const beforeRaw = req.query.before
    if (beforeRaw) {
      try {
        const parsed = JSON.parse(beforeRaw)
        if (parsed && typeof parsed === "object") {
          before = parsed
        } else {
          before = parseInt(beforeRaw) || 0
        }
      } catch {
        before = parseInt(beforeRaw) || 0
      }
    }
    const limit = Math.min(parseInt(req.query.limit) || 20, 100)
    const baseUrl = `${req.protocol}://${req.get('host')}`

    const messages = await getPrivateMessages(selfId, userId, before, limit, baseUrl)
    res.json(messages)
  } catch (err) {
    logger.error("[QQBot-Web] 私聊消息接口错误:", err)
    res.status(500).json({ error: String(err) })
  }
})

// 获取私聊消息原始数据
Bot.express.get(`${WEB_BASE}/api/bot/:selfId/private/:userId/message/raw`, async (req, res) => {
  try {
    const { selfId, userId } = req.params
    const msgIdx = req.query.msg_idx
    if (!msgIdx) return res.status(400).json({ error: "缺少 msg_idx 参数" })

    const raw = await getRawPrivateMessage(selfId, userId, msgIdx)
    if (raw) {
      res.json(raw)
    } else {
      res.status(404).json({ error: "消息未找到" })
    }
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 发送私聊消息
Bot.express.post(`${WEB_BASE}/api/bot/:selfId/private/:userId/send`, sendRawParser, async (req, res) => {
  try {
    const { selfId, userId } = req.params
    if (!Bot[selfId]) return res.status(404).json({ error: "Bot 未找到" })

    const msgType = req.headers["x-msg-type"] || "legacy"
    const baseUrl = `${req.protocol}://${req.get('host')}`
    const msgConfig = resolveSendConfig(req)
    const result = await sendPrivateMessage(selfId, userId, { ...msgConfig, msgType, baseUrl })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 按 openid 批量查询昵称（前端用于 @提及 补全）
// 可选 group_id：传入后同时查询群成员列表 (gml)
Bot.express.post(`${WEB_BASE}/api/bot/:selfId/nicknames`, async (req, res) => {
  try {
    const { selfId } = req.params
    if (!Bot[selfId]) return res.status(404).json({ error: "Bot 未找到" })
    const { openids = [], group_ids } = req.body || {}
    if (!Array.isArray(openids)) return res.status(400).json({ error: "openids 必须是数组" })
    const bot = Bot[selfId]
    const flMap = bot.fl instanceof Map ? bot.fl : null
    // 收集 gml：对每个 group_id 获取其成员 Map（兼容多种 key 格式）
    const sep = bot.adapter?.sep || ":"
    const gmlMaps = []
    if (Array.isArray(group_ids) && group_ids.length) {
      const gml = bot.gml
      if (gml && typeof gml.get === 'function') {
        for (const gid of group_ids) {
          if (!gid) continue
          const pureId = getPureGroupId(selfId, gid)
          try {
            const memberMap = await gml.get(gid)
              || await gml.get(pureId)
              || await gml.get(`${selfId}${sep}${pureId}`)
            if (memberMap instanceof Map) {
              gmlMaps.push(memberMap)
            }
          } catch(e) {}
        }
      }
    }
    const result = {}
    for (const uid of openids) {
      if (!uid || typeof uid !== "string") continue
      let info = null
      // 1. 先查 fl (好友列表) — 兼容多种 key 格式
      if (flMap) {
        info = flMap.get(uid)
          || flMap.get(`${selfId}${sep}${uid}`)
        // 如果 uid 本身带前缀，去掉后重试
        if (!info) {
          const stripped = uid.includes(sep) ? uid.split(sep).pop() : null
          if (stripped && stripped !== uid) {
            info = flMap.get(stripped)
              || flMap.get(`${selfId}${sep}${stripped}`)
          }
        }
      }
      // 2. 再查 gml (群成员列表) — key 可能带 selfId 前缀
      if (!info) {
        const prefixed = `${selfId}${sep}${uid}`
        for (const memberMap of gmlMaps) {
          info = memberMap.get(uid) || memberMap.get(prefixed)
          if (info) break
        }
      }
      result[uid] = info?.nickname || null
    }
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 查询审核状态（用于前端轮询，避免全量刷新闪烁）
Bot.express.get(`${WEB_BASE}/api/bot/:selfId/group/:groupId/audit-check/:auditId`, async (req, res) => {
  try {
    const { selfId, groupId, auditId } = req.params
    if (!Bot[selfId]) return res.status(404).json({ error: "Bot 未找到" })

    const val = await redis.get(`wind-audit-message_id:${auditId}`)
    if (!val) return res.json({ audit_status: "pending", audit_id: auditId })

    const ar = JSON.parse(val)
    if (ar.success && ar.id) {
      res.json({ audit_status: "passed", message_id: ar.id, audit_id: auditId })
    } else if (ar.success === false) {
      res.json({ audit_status: "rejected", audit_id: auditId })
    } else {
      res.json({ audit_status: "pending", audit_id: auditId })
    }
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 撤回群消息（支持通过 message_id 或 audit_id 撤回）
Bot.express.post(`${WEB_BASE}/api/bot/:selfId/group/:groupId/recall`, async (req, res) => {
  try {
    const { selfId, groupId } = req.params
    const { message_id, audit_id } = req.body
    if (!Bot[selfId]) return res.status(404).json({ error: "Bot 未找到" })

    const bot = Bot[selfId]
    const sdk = bot.sdk
    if (!sdk?.recallGroupMessage) return res.status(400).json({ error: "SDK 不支持撤回" })

    let msgId = null

    // 如果有 audit_id，优先从 Redis 查找审核通过后真实的 message_id
    // （注意：前端传来的 message_id 可能就是 audit_id 格式，不能直接用）
    if (audit_id) {
      try {
        const raw = await redis.get(`wind-audit-message_id:${audit_id}`)
        if (raw) {
          const ar = JSON.parse(raw)
          if (ar.success && ar.id) msgId = ar.id
        }
      } catch {}
    }

    // 回退到前端传的 message_id（排除 audit_id 伪格式）
    if (!msgId && message_id && !String(message_id).startsWith("msg_auditid_")) {
      msgId = message_id
    }

    if (!msgId) return res.status(400).json({ error: "无法确定 message_id，可能消息尚未通过审核或审核数据丢失" })

    const pureGroupId = getPureGroupId(selfId, groupId)
    const matchId = msgId
    const matchAuditId = audit_id
    const success = await sdk.recallGroupMessage(pureGroupId, msgId)

    if (success) {
      // 在 Redis 中标记消息已撤回（支持重启后仍显示撤回状态）
      try {
        const candidateKeys = [
          `wind-msg:group:${groupId}`,           // 用户消息
          `wind-bot-msg:group:${pureGroupId}`,    // bot 消息
          `wind-bot-msg:group:${groupId}`,        // bot 消息（完整格式兼容）
        ]
        for (const key of [...new Set(candidateKeys)]) {
          const all = await redis.zRange(key, 0, -1)
          for (const raw of all) {
            try {
              const m = JSON.parse(raw)
              const idMatch = (matchId && m.message_id === matchId) || (matchAuditId && m.audit_id === matchAuditId)
              if (idMatch && !m.recalled) {
                m.recalled = true
                await redis.zRem(key, raw)
                await redis.zAdd(key, { score: m.timestamp, value: JSON.stringify(m) })
                break
              }
            } catch {}
          }
        }
      } catch {}
    }

    // 在 SQLite 中标记撤回
    if (config.storageBackend === "sqlite" && Bot.MessageDB) {
      try {
        await Bot.MessageDB.markRecalledByMessageId(matchId)
      } catch {}
    }

    // 通知 WebSocket 客户端消息已撤回
    wsBroadcast(selfId, groupId, {
      type: "message_recalled",
      groupId,
      message_id: msgId,
      audit_id: audit_id || null,
    })

    res.json({ success })
  } catch (err) {
    logger.error("[QQBot-Web] 撤回消息失败:", err)
    // 从 SDK 错误中提取关键信息（避免返回包含超长 message_id 和 URI 的原始错误）
    const errStr = String(err.message || err)
    const codeMatch = errStr.match(/code\(([^)]+)\)(?::\s*(.+))?$/)
    const short = codeMatch
      ? `${codeMatch[1]}${codeMatch[2] ? `: ${codeMatch[2]}` : ""}`
      : errStr.slice(0, 300)
    res.status(500).json({ error: short })
  }
})

// 从 Redis 中删除消息（群聊）
Bot.express.post(`${WEB_BASE}/api/bot/:selfId/group/:groupId/message/delete`, async (req, res) => {
  try {
    const { selfId, groupId } = req.params
    const { msg_idx, message_id, audit_id, event_id } = req.body
    if (!msg_idx && !message_id && !audit_id && !event_id) return res.status(400).json({ error: "缺少 msg_idx / message_id / audit_id / event_id 参数" })

    const pureId = getPureGroupId(selfId, groupId)
    const keys = [
      `wind-msg:group:${groupId}`,
      `wind-bot-msg:group:${pureId}`,
      `wind-bot-msg:group:${groupId}`
    ]
    let removed = false
    let matchIdx = ""
    for (const key of [...new Set(keys)]) {
      const all = await redis.zRange(key, 0, -1)
      for (const raw of all) {
        try {
          const m = JSON.parse(raw)
          const idxMatch = msg_idx && String(m.msg_idx) === String(msg_idx)
          const idMatch = message_id && String(m.message_id) === String(message_id)
          const auditMatch = audit_id && String(m.audit_id) === String(audit_id)
          const eventMatch = event_id && String(m.event_id) === String(event_id)
          if (idxMatch || idMatch || auditMatch || eventMatch) {
            await redis.zRem(key, raw)
            removed = true
            matchIdx = msg_idx || m.msg_idx || ""
            break
          }
        } catch {}
      }
    }
    // 删除 wind-msg-idx 映射
    if (removed) {
      if (matchIdx) await redis.del(`wind-msg-idx:${matchIdx}`).catch(() => {})
      wsBroadcast(selfId, groupId, {
        type: "message_deleted",
        groupId,
        msg_idx: matchIdx,
      })
    }
    res.json({ success: removed })
  } catch (err) {
    logger.error("[QQBot-Web] 删除群消息失败:", err)
    res.status(500).json({ error: String(err) })
  }
})

// 从 Redis 中删除消息（私聊）
Bot.express.post(`${WEB_BASE}/api/bot/:selfId/private/:userId/message/delete`, async (req, res) => {
  try {
    const { selfId, userId } = req.params
    const { msg_idx, message_id, audit_id, event_id } = req.body
    if (!msg_idx && !message_id && !audit_id && !event_id) return res.status(400).json({ error: "缺少 msg_idx / message_id / audit_id / event_id 参数" })

    const keys = [
      `wind-msg:private:${userId}`,
      `wind-bot-msg:private:${userId}`
    ]
    let removed = false
    let matchIdx = ""
    for (const key of keys) {
      const all = await redis.zRange(key, 0, -1)
      for (const raw of all) {
        try {
          const m = JSON.parse(raw)
          const idxMatch = msg_idx && String(m.msg_idx) === String(msg_idx)
          const idMatch = message_id && String(m.message_id) === String(message_id)
          const auditMatch = audit_id && String(m.audit_id) === String(audit_id)
          const eventMatch = event_id && String(m.event_id) === String(event_id)
          if (idxMatch || idMatch || auditMatch || eventMatch) {
            await redis.zRem(key, raw)
            removed = true
            matchIdx = msg_idx || m.msg_idx || ""
            break
          }
        } catch {}
      }
    }
    if (removed) {
      if (matchIdx) await redis.del(`wind-msg-idx:${matchIdx}`).catch(() => {})
      wsBroadcastPrivate(selfId, userId, {
        type: "message_deleted",
        privateUserId: userId,
        msg_idx: matchIdx,
      })
    }
    res.json({ success: removed })
  } catch (err) {
    logger.error("[QQBot-Web] 删除私聊消息失败:", err)
    res.status(500).json({ error: String(err) })
  }
})

// 获取群详情
Bot.express.get(`${WEB_BASE}/api/bot/:selfId/group/:groupId/info`, async (req, res) => {
  try {
    const { selfId, groupId } = req.params
    if (!Bot[selfId]) return res.status(404).json({ error: "Bot 未找到" })

    const glMap = Bot[selfId]?.gl
    let info = { group_id: groupId }
    if (glMap) {
      const data = await glMap.get(groupId)
      if (data) {
        info = { ...data, group_id: groupId }
      }
    }
    res.json(info)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 获取群成员列表（从 gml 缓存，支持 ?q= 搜索昵称）
Bot.express.get(`${WEB_BASE}/api/bot/:selfId/group/:groupId/members`, async (req, res) => {
  try {
    const { selfId, groupId } = req.params
    const q = (req.query.q || "").trim().toLowerCase()

    const bot = Bot[selfId]
    if (!bot?.gml) return res.json({ members: [] })

    const sep = bot.adapter?.sep || ":"
    const pureId = getPureGroupId(selfId, groupId)

    let memberMap = null
    try {
      memberMap = await bot.gml.get(groupId)
        || await bot.gml.get(pureId)
        || await bot.gml.get(`${selfId}${sep}${pureId}`)
    } catch {}

    if (!(memberMap instanceof Map) || !memberMap.size) {
      return res.json({ members: [] })
    }

    const members = []
    for (const [userId, info] of memberMap) {
      const nick = info?.nickname || info?.openid || String(userId)
      if (q && !nick.toLowerCase().includes(q)) continue
      const uid = String(userId).includes(sep) ? String(userId).split(sep).pop() : String(userId)
      members.push({
        user_id: uid,
        nickname: nick,
        avatar: info?.avatar || "",
        unionid: info?.unionid || "",
        openid: info?.openid || uid,
      })
    }

    members.sort((a, b) => a.nickname.localeCompare(b.nickname, "zh"))
    res.json({ members, total: members.length })
  } catch (err) {
    logger.error("[QQBot-Web] 获取群成员失败:", err)
    res.status(500).json({ error: String(err) })
  }
})

// 获取所有群备注
Bot.express.get(`${WEB_BASE}/api/bot/:selfId/group-notes`, async (req, res) => {
  try {
    const { selfId } = req.params
    if (!Bot[selfId]) return res.status(404).json({ error: "Bot 未找到" })
    const notes = await redis.hGetAll("wind-group-name")
    res.json(notes || {})
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 设置/删除群备注
Bot.express.post(`${WEB_BASE}/api/bot/:selfId/group/:groupId/note`, async (req, res) => {
  try {
    const { selfId, groupId } = req.params
    if (!Bot[selfId]) return res.status(404).json({ error: "Bot 未找到" })
    const { note } = req.body
    if (!note || note.trim() === "") {
      await redis.hDel("wind-group-name", groupId)
    } else {
      await redis.hSet("wind-group-name", groupId, note.trim())
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 获取群号绑定列表
Bot.express.get(`${WEB_BASE}/api/group-bindings`, async (req, res) => {
  try {
    const session = await getSession(req)
    if (!session && config.login?.enabled !== false) return res.status(401).json({ error: "未登录" })
    const binds = await redis.hGetAll("wind-group-bind")
    res.json(binds || {})
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 绑定群号
Bot.express.post(`${WEB_BASE}/api/group-bind`, async (req, res) => {
  try {
    const session = await getSession(req)
    if (!session && config.login?.enabled !== false) return res.status(401).json({ error: "未登录" })
    const { groupId, groupQQ } = req.body || {}
    if (!groupId || !groupQQ) return res.status(400).json({ error: "缺少 groupId 或 groupQQ" })
    if (!/^\d{5,12}$/.test(String(groupQQ))) return res.status(400).json({ error: "QQ群号格式不正确（5-12位数字）" })

    const existingQQ = await redis.hGet('wind-group-bind', groupId)
    if (existingQQ) {
      return res.status(409).json({ error: `当前群已绑定QQ群号：${existingQQ}` })
    }
    // 检查是否已被其他群绑定
    const allBinds = await redis.hGetAll('wind-group-bind')
    const conflictGid = Object.entries(allBinds).find(([, qq]) => qq === String(groupQQ))?.[0]
    if (conflictGid && conflictGid !== groupId) {
      return res.status(409).json({ error: `QQ群号 ${groupQQ} 已被其他群绑定` })
    }

    await redis.hSet('wind-group-bind', groupId, String(groupQQ))

    res.json({ success: true, groupQQ })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 取消绑定群号
Bot.express.delete(`${WEB_BASE}/api/group-bind`, async (req, res) => {
  try {
    const session = await getSession(req)
    if (!session && config.login?.enabled !== false) return res.status(401).json({ error: "未登录" })
    const { groupId } = req.body || {}
    if (!groupId) return res.status(400).json({ error: "缺少 groupId" })

    const existingQQ = await redis.hGet('wind-group-bind', groupId)
    if (!existingQQ) return res.status(404).json({ error: "当前群未绑定QQ群号" })

    await redis.hDel('wind-group-bind', groupId)

    res.json({ success: true, groupQQ: existingQQ })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ========== 群绑定信息（仅绑定 QQ 号，群名/人数均来自 gl） ==========

// 获取全部群绑定信息（绑定 QQ 号）
Bot.express.get(`${WEB_BASE}/api/group-info/all`, async (req, res) => {
  try {
    const session = await getSession(req)
    if (!session && config.login?.enabled !== false) return res.status(401).json({ error: "未登录" })
    const binds = await redis.hGetAll('wind-group-bind')
    const result = {}
    for (const [gid, qq] of Object.entries(binds)) {
      // 群名与人数统一从 gl 读取（getGroupInfo 已写入），不再单独缓存
      const sep = ':'
      const selfId = gid.includes(sep) ? gid.slice(0, gid.indexOf(sep)) : ''
      const glMap = selfId ? Bot[selfId]?.gl : null
      const info = glMap ? (await glMap.get(gid)) || {} : {}
      result[gid] = {
        qq,
        group_name: info?.group_name || info?.name || '',
        member_count: info?.group_member_num ?? info?.member_count ?? 0,
      }
    }
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ========== 系统信息 ==========

// 计算 CPU 使用率（两次调用取差值）
let prevCpuInfo = null
let prevCpuTime = 0
let prevProcessCpu = null
let prevProcessCpuTime = 0

Bot.express.get(`${WEB_BASE}/api/system-info`, async (req, res) => {
  try {
    const session = await getSession(req)
    if (!session && config.login?.enabled !== false) return res.status(401).json({ error: "未登录" })
    const cpus = os.cpus()
    const cpuModel = cpus[0]?.model || "Unknown"
    const cpuCores = cpus.length

    // CPU 使用百分比
    let cpuUsagePercent = null
    const now = Date.now()
    if (prevCpuInfo && prevCpuTime) {
      let totalDiff = 0, idleDiff = 0
      for (let i = 0; i < cpus.length; i++) {
        const prev = prevCpuInfo[i]?.times || {}
        const cur = cpus[i]?.times || {}
        const prevTotal = (prev.user || 0) + (prev.nice || 0) + (prev.sys || 0) + (prev.idle || 0) + (prev.irq || 0)
        const curTotal = (cur.user || 0) + (cur.nice || 0) + (cur.sys || 0) + (cur.idle || 0) + (cur.irq || 0)
        totalDiff += curTotal - prevTotal
        idleDiff += (cur.idle || 0) - (prev.idle || 0)
      }
      if (totalDiff > 0) {
        cpuUsagePercent = Math.round((1 - idleDiff / totalDiff) * 100)
      }
    }
    prevCpuInfo = cpus
    prevCpuTime = now

    // 内存
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedMem = totalMem - freeMem
    const memUsagePercent = Math.round((usedMem / totalMem) * 100)

    // 磁盘（获取所有磁盘）
    let disks = []
    try {
      if (process.platform === "win32") {
        // Windows: 获取所有逻辑盘
        const raw = execSync(
          'wmic logicaldisk get DeviceID,Size,FreeSpace /format:csv',
          { timeout: 8000, windowsHide: true }
        ).toString().trim()
        const lines = raw.split("\n").filter(Boolean)
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(",")
          if (cols.length < 3) continue
          const mount = cols[1]?.trim()
          const nums = cols.slice(2).map(c => parseInt(c, 10)).filter(n => !isNaN(n) && n > 0)
          if (mount && nums.length >= 2) {
            const total = Math.max(...nums)
            const free = Math.min(...nums)
            if (total > 0) {
              disks.push({
                total,
                free,
                used: total - free,
                usagePercent: Math.round(((total - free) / total) * 100),
                mount,
              })
            }
          }
        }
      } else {
        // Linux/Mac: df 命令列出所有挂载点
        const raw = execSync("df -B1 --type=ext4 --type=xfs --type=btrfs --type=apfs --type=hfs 2>/dev/null || df -B1 / | tail -n +2", { timeout: 8000 }).toString().trim()
        const lines = raw.split("\n").filter(Boolean)
        for (const line of lines) {
          const parts = line.split(/\s+/)
          if (parts.length >= 4) {
            const total = parseInt(parts[1], 10)
            const used = parseInt(parts[2], 10)
            if (total > 0) {
              disks.push({
                total,
                free: total - used,
                used,
                usagePercent: Math.round((used / total) * 100),
                mount: parts[5] || parts[0] || "?",
              })
            }
          }
        }
      }
    } catch {
      // 磁盘信息获取失败
    }

    // 机器人运行时间（取最早启动的 bot 的运行秒数）
    let uptime = 0
    if (Bot.uin && Bot.uin.length > 0) {
      const now = Date.now()
      let earliestStart = Infinity
      for (const id of Bot.uin) {
        const startSec = Bot[id]?.stat?.start_time
        if (startSec) earliestStart = Math.min(earliestStart, startSec * 1000)
      }
      if (earliestStart < Infinity) {
        uptime = Math.floor((now - earliestStart) / 1000)
      }
    }
    if (!uptime) uptime = Math.floor(os.uptime())

    // 进程 CPU 使用率（delta 计算）
    let processCpuPercent = null
    const processCpu = process.cpuUsage()
    if (prevProcessCpu && prevProcessCpuTime) {
      const elapsedUs = (now - prevProcessCpuTime) * 1000 // ms → μs
      if (elapsedUs > 0) {
        const cpuDeltaUs = (processCpu.user - prevProcessCpu.user) + (processCpu.system - prevProcessCpu.system)
        processCpuPercent = Math.round((cpuDeltaUs / elapsedUs / cpuCores) * 100)
      }
    }
    prevProcessCpu = processCpu
    prevProcessCpuTime = now

    // 进程内存
    const procMem = process.memoryUsage()
    const processMem = procMem.rss // 常驻集大小 (字节)

    // CPU 频率
    const cpuSpeed = cpus[0]?.speed || null // MHz

    // 版本信息
    let webAdapterVersion = WEB_ADAPTER_VERSION, qqbotPluginVersion = "未知"
    // QQBot-Plugin 版本从 Bot[uin].adapter.version 获取
    if (Bot.uin && Bot.uin.length > 0) {
      const firstId = Bot.uin[0]
      if (Bot[firstId]?.adapter?.version) {
        qqbotPluginVersion = Bot[firstId].adapter.version
      }
    }

    // 系统信息
    const systemInfo = {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
    }

    // Bot 数量（从 Bot.uin 内存列表中获取，过滤 QQBot 适配器）
    let botCount = getBots().length

    // fastfetch 系统信息（异步预计算 + 缓存，不阻塞请求）
    let fastfetchHtml
    const fallbackFastfetch = () =>
      buildSystemProfileHtml(systemInfo, cpuModel, cpuCores, cpuSpeed, uptime, totalMem, webAdapterVersion, qqbotPluginVersion)

    if (!fastfetchComputed) {
      // 还在计算中 / 未启动计算 → 先用 Node.js 兜底，后台触发计算
      computeFastfetchInBackground()
      fastfetchHtml = fallbackFastfetch()
    } else {
      fastfetchHtml = cachedFastfetchHtml || fallbackFastfetch()
    }

    res.json({
      cpu: {
        model: cpuModel,
        cores: cpuCores,
        speed: cpuSpeed,
        usagePercent: cpuUsagePercent,
        processUsagePercent: processCpuPercent,
      },
      memory: {
        total: totalMem,
        free: freeMem,
        used: usedMem,
        usagePercent: memUsagePercent,
        process: processMem,
      },
      disk: disks.length > 0 ? disks : null,
      disks,
      uptime,
      versions: {
        webAdapter: webAdapterVersion,
        qqbotPlugin: qqbotPluginVersion,
      },
      system: systemInfo,
      botCount,
      fastfetch: fastfetchHtml,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ========== 图片上传 ==========

// 图片上传接口（用于聊天输入框和 Ark 表单的图片上传）
Bot.express.post(`${WEB_BASE}/api/bot/:selfId/upload-image`, async (req, res) => {
  try {
    const { selfId } = req.params
    if (!Bot[selfId]) return res.status(404).json({ error: "Bot 未找到" })

    const { data, name } = req.body || {}
    if (!data) return res.status(400).json({ error: "缺少图片数据" })

    // 解析 base64 data URL: data:image/png;base64,xxxx
    const matches = data.match(/^data:(image\/[^;]+);base64,(.+)$/)
    if (!matches) return res.status(400).json({ error: "无效的图片数据格式" })

    const mimeType = matches[1]
    const base64Data = matches[2]
    const buffer = Buffer.from(base64Data, "base64")
    const ext = mimeType.split("/")[1] || "png"
    const safeName = (name || `upload_${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, "_")

    // 写入临时文件
    const tempPath = path.join(os.tmpdir(), `qqbot_upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`)
    await fs.writeFile(tempPath, buffer)

    try {
      let url
      // 优先使用 Bot.imageToUrl（如果存在），否则使用 Bot.fileToUrl
      if (typeof Bot.imageToUrl === "function") {
        url = await Bot.imageToUrl(tempPath, { autoDelete: 300 })
      } else {
        url = await Bot.fileToUrl(tempPath, { name: safeName, time: 300 * 1000 })
      }
      res.json({ url: String(url) })
    } finally {
      // 清理临时文件
      await fs.unlink(tempPath).catch(() => {})
    }
  } catch (err) {
    logger.error("[QQBot-Web] 图片上传失败:", err)
    res.status(500).json({ error: String(err) })
  }
})

// 图片上传接口（raw 二进制，避免大图片 base64 在 JSON.stringify 时栈溢出）
Bot.express.post(`${WEB_BASE}/api/bot/:selfId/upload-image-raw`, express.raw({ type: "*/*", limit: "200mb" }), async (req, res) => {
  try {
    const { selfId } = req.params
    if (!Bot[selfId]) return res.status(404).json({ error: "Bot 未找到" })

    const buffer = req.body
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ error: "缺少图片数据" })
    }

    const mimeType = req.headers["x-mime-type"] || "image/png"
    const fileName = (req.headers["x-file-name"] || `upload_${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, "_")
    const ext = mimeType.split("/")[1] || "png"

    const tempPath = path.join(os.tmpdir(), `qqbot_upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`)
    await fs.writeFile(tempPath, buffer)

    try {
      let url
      if (typeof Bot.imageToUrl === "function") {
        url = await Bot.imageToUrl(tempPath, { autoDelete: 300 })
      } else {
        url = await Bot.fileToUrl(tempPath, { name: fileName, time: 300 * 1000 })
      }
      res.json({ url: String(url) })
    } finally {
      await fs.unlink(tempPath).catch(() => {})
    }
  } catch (err) {
    logger.error("[QQBot-Web] 图片上传(raw)失败:", err)
    res.status(500).json({ error: String(err) })
  }
})

// ========== 表情包管理 ==========
import * as emojiStore from "../QQBot-Plugin/lib/emojiStore.js"
import { parseMultipart } from "../QQBot-Plugin/lib/multipart.js"

// 从 parseMultipart 返回的文件中取图标 buffer 与扩展名
function readEmojiIcon(file) {
  if (!file) return { iconBuffer: undefined, iconExt: undefined }
  const iconBuffer = file.buffer || Buffer.alloc(0)
  const iconExt = (file.filename || "").split(".").pop().toLowerCase() || "png"
  return { iconBuffer, iconExt }
}


// 表情包静态资源（图片直链）
Bot.express.use(`${WEB_BASE}/emoji-static`, express.static(emojiStore.getEmojiRoot()))

// 列出所有表情列表
Bot.express.get(`${WEB_BASE}/api/emoji/lists`, async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    const lists = await emojiStore.listLists()
    res.json({ lists })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 创建表情列表（支持 multipart 上传图标图片，也支持 JSON）
Bot.express.post(`${WEB_BASE}/api/emoji/lists`, async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    const ct = req.headers["content-type"] || ""
    if (ct.includes("multipart")) {
      const { fields, files } = await parseMultipart(req)
      const title = (fields.title || "").trim()
      const folder = (fields.folder || "").trim()
      if (!title) return res.status(400).json({ error: "缺少 title（标题必填）" })
      const { iconBuffer, iconExt } = readEmojiIcon(files[0])
      const list = await emojiStore.createList({ title, folder, iconBuffer, iconExt })
      res.json({ list })
    } else {
      const { title, icon, folder } = req.body || {}
      if (!title) return res.status(400).json({ error: "缺少 title（标题必填）" })
      const list = await emojiStore.createList({ title, icon, folder })
      res.json({ list })
    }
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 删除表情列表
Bot.express.delete(`${WEB_BASE}/api/emoji/lists/:folder`, async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    await emojiStore.deleteList(req.params.folder)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 修改表情列表设置（标题 / 图标图片）
Bot.express.patch(`${WEB_BASE}/api/emoji/lists/:folder`, async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    const ct = req.headers["content-type"] || ""
    if (ct.includes("multipart")) {
      const { fields, files } = await parseMultipart(req)
      const { iconBuffer, iconExt } = readEmojiIcon(files[0])
      const list = await emojiStore.updateList(req.params.folder, {
        title: fields.title,
        iconBuffer,
        iconExt,
      })
      res.json({ list })
    } else {
      const { title, icon } = req.body || {}
      const list = await emojiStore.updateList(req.params.folder, { title, icon })
      res.json({ list })
    }
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 调整列表顺序
Bot.express.post(`${WEB_BASE}/api/emoji/lists/reorder`, express.json(), async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    const { order } = req.body || {}
    if (!Array.isArray(order)) return res.status(400).json({ error: "order 必须为数组" })
    await emojiStore.reorderLists(order)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 获取某列表下的表情
Bot.express.get(`${WEB_BASE}/api/emoji/lists/:folder/emojis`, async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    const emojis = await emojiStore.listEmojis(req.params.folder, WEB_BASE)
    res.json({ emojis })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 向列表添加表情图片（支持多文件：单图 / 图集压缩包 / 文件夹）
// 注意：不使用 express.raw，由 parseMultipart 直接从流解析 multipart 请求体
Bot.express.post(`${WEB_BASE}/api/emoji/lists/:folder/emojis`, async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    const { files } = await parseMultipart(req)
    if (!files.length) return res.status(400).json({ error: "缺少文件" })
    // 处理压缩包（zip）：解压后把图片加入；文件夹上传同理（多文件）
    let all = files
    const zips = files.filter(f => /\.zip$/i.test(f.filename))
    if (zips.length) {
      const { extractZipImages } = await import("../QQBot-Plugin/lib/zipEmoji.js")
      const extracted = await extractZipImages(zips)
      all = files.filter(f => !/\.zip$/i.test(f.filename)).concat(extracted)
    }
    const result = await emojiStore.addEmojis(req.params.folder, all)
    res.json({ added: result.added, skipped: result.skipped || 0 })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 同步文件夹：清理失效记录并载入文件夹内未记录的图片
Bot.express.post(`${WEB_BASE}/api/emoji/lists/:folder/sync`, async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    const result = await emojiStore.syncFolder(req.params.folder)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 删除单个表情
Bot.express.delete(`${WEB_BASE}/api/emoji/lists/:folder/emojis/:file`, async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    await emojiStore.deleteEmoji(req.params.folder, req.params.file)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 调整表情顺序
Bot.express.post(`${WEB_BASE}/api/emoji/lists/:folder/emojis/reorder`, express.json(), async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    const { order } = req.body || {}
    if (!Array.isArray(order)) return res.status(400).json({ error: "order 必须为数组" })
    await emojiStore.reorderEmojis(req.params.folder, order)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ========== 缓存大小 ==========

Bot.express.get(`${WEB_BASE}/api/cache-size`, async (req, res) => {
  try {
    const session = await getSession(req)
    if (!session) return res.status(401).json({ error: "未登录" })
    const { totalSize, fileCount } = await calcDirSize(QQBT_DATA_IMGS_DIR)
    res.json({ size: totalSize, fileCount })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

async function calcDirSize(dirPath) {
  let totalSize = 0
  let fileCount = 0
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile()) {
        const stat = await fs.stat(path.join(dirPath, entry.name))
        totalSize += stat.size
        fileCount++
      }
    }
  } catch { /* 目录不存在视为0 */ }
  return { totalSize, fileCount }
}

// ========== 配置管理 ==========

// 获取当前配置（密码脱敏）
Bot.express.get(`${WEB_BASE}/api/config`, async (req, res) => {
  try {
    const session = await getSession(req)
    if (!session && config.login?.enabled !== false) return res.status(401).json({ error: "未登录" })
    const safe = {
      basePath: config.basePath,
      autoRecordMessage: config.autoRecordMessage !== false,
      autoDownloadImgorVideo: config.autoDownloadImgorVideo !== false,
      saveTimes: [1, 2, 3, 4, 5, 6, 7].includes(config.saveTimes) ? config.saveTimes : 3,
      maxMediaCacheSize: config.maxMediaCacheSize || 10,
      login: {
        enabled: config.login.enabled,
        username: config.login.username,
        password: config.login.password ? "••••••••" : "",
      },
      notifyUserId: config.notifyUserId || "",
      publicAccess: config.publicAccess === true,
      storageBackend: config.storageBackend === "sqlite" ? "sqlite" : "redis",
      enableQuanliangCommands: config.enableQuanliangCommands !== false,
      httpLogSilent: !!config.httpLogSilent,
    }
    res.json(safe)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 生成验证码并输出到日志（3分钟有效期）
Bot.express.post(`${WEB_BASE}/api/config/send-code`, async (req, res) => {
  try {
    const session = await getSession(req)
    if (!session) return res.status(401).json({ error: "未登录" })

    // 检查是否今天已被封禁
    const blockKey = `wind-config-blocked:${session.username}`
    const blocked = await redis.get(blockKey)
    if (blocked) {
      return res.status(403).json({ error: "今日验证码重试次数已用完，请明天再试" })
    }

    // 检查发送冷却（60秒内不能重复获取）
    const cooldownKey = `wind-config-code-cooldown:${session.username}`
    const cooldownRemaining = await redis.ttl(cooldownKey)
    if (cooldownRemaining > 0) {
      return res.status(429).json({ error: `请等待 ${cooldownRemaining} 秒后再获取验证码`, cooldown: cooldownRemaining })
    }

    // 生成32位字母数字混合验证码
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
    let code = ''
    for (let i = 0; i < 32; i++) {
      code += chars[Math.floor(Math.random() * chars.length)]
    }

    // 存到 Redis，3分钟过期
    const codeKey = `wind-config-code:${session.username}`
    await redis.setEx(codeKey, 180, code)
    // 发送冷却 60 秒
    await redis.setEx(cooldownKey, 60, "1")

    // 输出到日志（加粗醒目）
    logger.mark(`[QQBot-Web] ========================================`)
    logger.mark(`[QQBot-Web] 配置修改验证码：${logger.red(code)}`)
    logger.mark(`[QQBot-Web] 有效期 3 分钟，请在日志中查看`)
    logger.mark(`[QQBot-Web] ========================================`)

    // 同时发送给通知用户
    notifyCaptchaCode("config", code)

    // 重置重试计数
    await redis.del(`wind-config-attempts:${session.username}`)

    res.json({ ok: true, expires: 180 })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 保存配置
Bot.express.post(`${WEB_BASE}/api/config/save`, async (req, res) => {
  try {
    const session = await getSession(req)
    if (!session) return res.status(401).json({ error: "未登录" })

    const { basePath, username, password, code, autoRecordMessage, autoDownloadImgorVideo, maxMediaCacheSize, saveTimes, storageBackend, loginEnabled, notifyUserId, publicAccess, enableQuanliangCommands, httpLogSilent } = req.body || {}

    // 检查今天是否已被封禁
    const blockKey = `wind-config-blocked:${session.username}`
    const blocked = await redis.get(blockKey)
    if (blocked) {
      return res.status(403).json({ error: "今日验证码重试次数已用完，请明天再试" })
    }

    // 检测是否有敏感字段变更
    const hasSensitiveChange =
      (basePath !== undefined && basePath !== config.basePath) ||
      (username !== undefined && username !== config.login.username) ||
      (password !== undefined && password !== "••••••••" && password !== "") ||
      (loginEnabled !== undefined && loginEnabled !== config.login.enabled) ||
      (notifyUserId !== undefined && notifyUserId !== (config.notifyUserId || "")) ||
      (storageBackend !== undefined && storageBackend !== (config.storageBackend || "redis"))

    if (hasSensitiveChange) {
      // 需要验证码
      if (!code || code.length !== 32) {
        return res.status(400).json({ error: "修改敏感设置需要验证码", needCode: true })
      }

      // 从 Redis 获取验证码
      const codeKey = `wind-config-code:${session.username}`
      const storedCode = await redis.get(codeKey)

      if (!storedCode) {
        return res.status(400).json({ error: "验证码不存在或已过期（有效期3分钟），请重新获取" })
      }

      if (code !== storedCode) {
        // 验证失败，增加重试计数
        const attemptKey = `wind-config-attempts:${session.username}`
        const attemptsStr = await redis.get(attemptKey)
        const attempts = (parseInt(attemptsStr) || 0) + 1

        if (attempts >= 5) {
          // 5次失败，封禁到今天结束
          const now = new Date()
          const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
          const ttl = Math.ceil((endOfDay - now) / 1000)
          await redis.setEx(blockKey, ttl, "1")
          await redis.del(codeKey)
          await redis.del(attemptKey)
          return res.status(403).json({ error: "验证码错误次数过多（5次），今日已禁止通过面板修改配置" })
        }

        await redis.setEx(attemptKey, 1800, String(attempts))
        const remaining = 5 - attempts
        return res.status(400).json({ error: `验证码错误，还剩 ${remaining} 次重试机会` })
      }

      // 验证通过，删除验证码与发送冷却，便于再次获取新验证码
      await redis.del(codeKey)
      await redis.del(`wind-config-attempts:${session.username}`)
      await redis.del(`wind-config-code-cooldown:${session.username}`)
    }

    // 保存变更前记录原始凭据（用于判断是否需要清除 session）
    const oldUsername = config.login.username
    const oldPassword = config.login.password
    const oldStorageBackend = config.storageBackend === "sqlite" ? "sqlite" : "redis"

    // 保存配置
    if (basePath !== undefined) config.basePath = basePath
    if (username !== undefined) config.login.username = username
    if (password !== undefined && password !== "••••••••") config.login.password = password
    if (loginEnabled !== undefined) config.login.enabled = !!loginEnabled
    if (autoRecordMessage !== undefined) config.autoRecordMessage = !!autoRecordMessage
    if (autoDownloadImgorVideo !== undefined) config.autoDownloadImgorVideo = !!autoDownloadImgorVideo
    if (saveTimes !== undefined) {
      const val = Number(saveTimes)
      config.saveTimes = [1, 2, 3, 4, 5, 6, 7].includes(val) ? val : 3
    }
    if (maxMediaCacheSize !== undefined) {
      const val = Number(maxMediaCacheSize)
      config.maxMediaCacheSize = (Number.isFinite(val) && val >= 1 && val <= 100) ? Math.floor(val) : 10
    }
    if (notifyUserId !== undefined) config.notifyUserId = String(notifyUserId).trim()
    if (storageBackend !== undefined) config.storageBackend = storageBackend === "sqlite" ? "sqlite" : "redis"
    if (enableQuanliangCommands !== undefined) config.enableQuanliangCommands = !!enableQuanliangCommands
    if (httpLogSilent !== undefined) {
      config.httpLogSilent = !!httpLogSilent
      // 控制 Bot.express.quiet：静默 /basePath、/.well-known
      const qp = [`/${config.basePath}`, '/.well-known']
      if (config.httpLogSilent) {
        for (const p of qp) {
          if (!Bot.express.quiet.includes(p)) Bot.express.quiet.push(p)
        }
      } else {
        Bot.express.quiet = Bot.express.quiet.filter(p => !qp.includes(p))
      }
    }
    if (publicAccess !== undefined) config.publicAccess = !!publicAccess

    // 同步到 Bot 全局
    Bot.autoRecordMessage = config.autoRecordMessage !== false
    Bot.autoDownloadImgorVideo = config.autoDownloadImgorVideo !== false
    Bot.saveTimes = [1, 2, 3, 4, 5, 6, 7].includes(config.saveTimes) ? config.saveTimes : 3
    Bot.notifyUserId = typeof config.notifyUserId === "string" ? config.notifyUserId : ""
    Bot.storageBackend = config.storageBackend === "sqlite" ? "sqlite" : "redis"
    const mcs = Number(config.maxMediaCacheSize)
    Bot.maxMediaCacheSize = (Number.isFinite(mcs) && mcs >= 1 && mcs <= 100) ? Math.floor(mcs) : 10

    await configSave()

    // 存储后端切换时，自动把旧后端的置顶数据迁移到新后端
    if (storageBackend !== undefined && oldStorageBackend !== config.storageBackend) {
      try {
        await migratePins(oldStorageBackend, config.storageBackend)
        logger.mark(`[QQBot-Web] 置顶数据已从 ${oldStorageBackend} 迁移到 ${config.storageBackend}`)
      } catch (e) {
        logger.error(`[QQBot-Web] 置顶数据迁移失败: ${e.stack || e.message}`)
      }
    }

    // 如果用户名或密码有变更，使所有 session 失效（所有已登录设备需重新登录）
    if ((username !== undefined && username !== oldUsername) ||
        (password !== undefined && password !== "••••••••" && password !== oldPassword)) {
      try {
        await purgeAllSessions()
        logger.mark("[QQBot-Web] 凭据已变更，所有 session 已失效")
      } catch (e) {
        logger.debug(`[QQBot-Web] 清除 session 失败: ${e.message}`)
      }
    }

    // 设置变动通知：如果 notifyUserId 已设置，向该用户发送变更通知（走适配器链，消息会被记录）
    const notifyId = config.notifyUserId?.trim()
    if (notifyId) {
      try {
        // 通过各 Bot 的 fl (friendMap) 查找 notifyUserId 属于哪个 Bot
        // notifyUserId 可能是 "botqq:openid" 完整格式，也可能仅是 "openid"
        let targetBotId = null
        let resolvedUserId = notifyId
        if (Bot.uin?.length > 0) {
          for (const id of Bot.uin) {
            if (!Bot[id]?.adapter) continue
            // 第一优先级：notifyId 原值直接命中 fl（用户填了完整 botqq+sep+openid）
            if (Bot[id].fl?.has?.(notifyId)) {
              targetBotId = id
              break
            }
            // 第二优先级：用当前 Bot 的 sep 拼接 id+sep+notifyId 再查（用户只填了 openid）
            const sep = Bot[id].adapter.sep
            if (sep) {
              const lookupKey = `${id}${sep}${notifyId}`
              if (Bot[id].fl?.has?.(lookupKey)) {
                targetBotId = id
                resolvedUserId = lookupKey
                break
              }
            }
          }
        }
        // 构建变更描述（按设置页面分类，修改项加 ✓ 已修改 标记）
        const mark = (changed) => changed ? " ✓ 已修改" : ""
        const parts = []
        const base = [
          `Base Path: ${config.basePath}${mark(basePath !== undefined)}`,
          `登录开关: ${config.login.enabled ? "已启用" : "已关闭"}${mark(loginEnabled !== undefined)}`,
          `用户名: ${config.login.username}${mark(username !== undefined)}`,
          `密码: ${password !== undefined && password !== "••••••••" ? "已变更 ✓ 已修改" : "未变更"}`,
        ]
        const storage = [
          `消息记录开关: ${config.autoRecordMessage ? "已启用" : "已关闭"}${mark(autoRecordMessage !== undefined)}`,
          `图片/视频缓存: ${config.autoDownloadImgorVideo ? "已启用" : "已关闭"}${mark(autoDownloadImgorVideo !== undefined)}`,
          `缓存大小上限: ${config.maxMediaCacheSize || 10} MB${mark(maxMediaCacheSize !== undefined)}`,
          `记录/缓存保留天数: ${config.saveTimes} 天${mark(saveTimes !== undefined)}`,
          `消息存储后端: ${config.storageBackend === "sqlite" ? "SQLite" : "Redis"}${mark(storageBackend !== undefined)}`,
        ]
        const security = [
          `通知用户ID: ${config.notifyUserId || "已清除"}${mark(notifyUserId !== undefined)}`,
          `公网访问: ${config.publicAccess ? "已开启" : "已关闭"}${mark(publicAccess !== undefined)}`,
        ]
        const other = [
          `全量群指令开关: ${config.enableQuanliangCommands ? "已启用" : "已关闭"}${mark(enableQuanliangCommands !== undefined)}`,
          `HTTP日志静默: ${config.httpLogSilent ? "已启用" : "已关闭"}${mark(httpLogSilent !== undefined)}`,
        ]
        if (base.some(Boolean)) parts.push("【基础设置】\n" + base.join("\n"))
        if (storage.some(Boolean)) parts.push("【消息存储设置】\n" + storage.join("\n"))
        if (security.some(Boolean)) parts.push("【通知与安全】\n" + security.join("\n"))
        if (other.some(Boolean)) parts.push("【其他设置】\n" + other.join("\n"))
        const changeDesc = parts.length > 0 ? parts.join("\n\n") : "配置已更新"
        const opIp = getClientIp(req)
        const opRegion = await getIpRegion(opIp)
        const finalMsg = `QQBot 控制台设置变更通知\n\n${changeDesc}\n\n操作人: ${session.username}\nIP: ${opIp}\n地区: ${opRegion}`
        if (targetBotId) {
          // 走 Bot.sendFriendMsg 正规链路：pickFriend → sendMsg → sendFriendMsg → sendMsg → _saveSentMessage
          // 确保消息写入 Redis 聊天记录
          await Bot.sendFriendMsg(targetBotId, resolvedUserId, finalMsg)
          logger.mark(`[QQBot-Web] 已向通知用户 ${notifyId} 发送设置变更通知 (bot: ${targetBotId})`)
        } else {
          logger.warn(`[QQBot-Web] 未找到通知用户 ${notifyId} 对应的 Bot，无法发送设置变更通知`)
        }
      } catch (notifyErr) {
        logger.debug(`[QQBot-Web] 发送设置变更通知失败: ${notifyErr.message}`)
      }
    }

    res.json({ ok: true, message: "配置已保存，重启后生效" })
  } catch (err) {
    logger.error("[QQBot-Web] 保存配置失败:", err)
    res.status(500).json({ error: String(err) })
  }
})

// ========== 添加 Bot ==========

const REDIS_QR_TASK_PREFIX = "wind-qr-task:"  // username → { taskId, key, createdAt }
const QR_TASK_CACHE_TTL = 180                   // QR 任务缓存 3 分钟

// 扫码登录 - 创建绑定任务（带 Redis 缓存，避免重复请求被拉黑 IP）
Bot.express.post(`${WEB_BASE}/api/bot/add-qr-start`, async (req, res) => {
  try {
    const session = await getSession(req)
    if (!session && config.login?.enabled !== false) return res.status(401).json({ error: "未登录" })
    const forceRefresh = req.body?.refresh === true

    // 强制刷新时删除缓存
    if (forceRefresh) {
      try { await redis.del(`${REDIS_QR_TASK_PREFIX}${session.username}`) } catch {}
    }

    // 检查缓存
    if (!forceRefresh) {
      try {
        const cached = await redis.get(`${REDIS_QR_TASK_PREFIX}${session.username}`)
        if (cached) {
          const parsed = JSON.parse(cached)
          const qrUrl = QR_URL_TPL.replace("{task_id}", parsed.taskId)
          const qrImage = parsed.qrImage || null
          return res.json({ ok: true, taskId: parsed.taskId, key: parsed.key, qrUrl, qrImage, cached: true })
        }
      } catch {}
    }

    const { taskId, key } = await qrCreateBindTask()
    const qrUrl = QR_URL_TPL.replace("{task_id}", taskId)

    // 生成真实二维码图片
    let qrImage = null
    try {
      if (QRCode) {
        qrImage = await QRCode.toDataURL(qrUrl, { width: 200, margin: 2 })
      }
    } catch {}

    // 缓存到 Redis（3 分钟，含 qrImage）
    try {
      await redis.setEx(`${REDIS_QR_TASK_PREFIX}${session.username}`, QR_TASK_CACHE_TTL,
        JSON.stringify({ taskId, key, qrImage }))
    } catch {}

    res.json({ ok: true, taskId, key, qrUrl, qrImage })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 扫码登录 - 轮询结果（单次检查，前端 2s 轮询）
Bot.express.post(`${WEB_BASE}/api/bot/add-qr-poll`, async (req, res) => {
  try {
    const session = await getSession(req)
    if (!session && config.login?.enabled !== false) return res.status(401).json({ error: "未登录" })
    const { taskId, key } = req.body || {}
    if (!taskId || !key) return res.status(400).json({ error: "缺少 taskId 或 key" })
    const result = await qrPollBindResult(taskId)
    if (result.status === "timeout") {
      try { await redis.del(`${REDIS_QR_TASK_PREFIX}${session.username}`) } catch {}
      return res.json({ status: "timeout" })
    }
    if (result.status !== "ok") return res.json({ status: "waiting" })
    const secret = qrDecryptSecret(result.data.bot_encrypt_secret, key)
    const uin = await qrGetRobotUin(result.data.bot_appid)
    if (!uin) return res.status(500).json({ error: "获取机器人 uin 失败" })
    // 扫码成功 → 删除缓存
    try { await redis.del(`${REDIS_QR_TASK_PREFIX}${session.username}`) } catch {}
    const { uin: uinStr, appid, existed } = await saveAndConnectBot(uin, result.data.bot_appid, secret, "1", "0")
    res.json({ status: "ok", uin: uinStr, appid, existed })
  } catch (err) {
    logger.error("[QQBot-Web] add-qr-poll 失败:", err)
    res.status(500).json({ error: String(err) })
  }
})

// AppID 登录 - 通过 appid+secret 添加 Bot
Bot.express.post(`${WEB_BASE}/api/bot/add-by-appid`, async (req, res) => {
  try {
    const session = await getSession(req)
    if (!session && config.login?.enabled !== false) return res.status(401).json({ error: "未登录" })
    const { appid, secret, mode, privateDomain } = req.body || {}
    if (!appid || !secret) return res.status(400).json({ error: "缺少 appid 或 secret" })

    // 通过 share_info 接口获取机器人 uin
    const uin = await qrGetRobotUin(appid)
    if (!uin) return res.status(400).json({ error: "无法获取机器人信息，请确认 AppID 正确" })

    // 组装 token
    const connMode = mode === "webhook" ? "2" : "1"
    const pdFlag = privateDomain ? "1" : "0"
    const result = await saveAndConnectBot(uin, appid, secret, connMode, pdFlag)
    res.json({ ok: true, ...result })
  } catch (err) {
    logger.error("[QQBot-Web] add-by-appid 失败:", err)
    res.status(500).json({ error: String(err) })
  }
})

// ========== 黑名单 API ==========

// 获取指定 Bot 的黑名单（含用户/群详情）
Bot.express.get(`${WEB_BASE}/api/bot/:selfId/blacklist`, async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    const { selfId } = req.params
    if (!Bot[selfId]) return res.status(404).json({ error: "Bot 未找到" })

    const data = getBlacklistData(selfId)
    const sep = Bot[selfId]?.adapter?.sep || ":"
    const fl = Bot[selfId]?.fl
    const gl = Bot[selfId]?.gl

    // 丰富用户信息（data.userid 是去掉 selfId{sep} 前缀后的纯 openid）
    const users = []
    for (const openid of data.userid) {
      const uid = `${selfId}${sep}${openid}`
      const info = fl?.get?.(uid) || fl?.get?.(openid) || {}
      users.push({
        openid,
        unionid: info.unionid || "",
        nickname: info.nickname || openid,
        avatar: info.avatar || (info.bot !== undefined ? `https://q.qlogo.cn/qqapp/${Bot[selfId].info.appid}/${openid}/0` : ""),
      })
    }

    // 丰富群信息
    const groups = []
    const groupNotes = await redis.hGetAll("wind-group-name").catch(() => ({}))
    const groupBinds = await redis.hGetAll("wind-group-bind").catch(() => ({}))
    for (const gid of data.groups) {
      const info = gl?.get?.(gid) || gl?.get?.(gid.slice(gid.indexOf(sep) + 1)) || {}
      // 优先使用群备注，其次绑定群的 QQ 群名，然后 gl 中的名称，最后回退到 group_id
      const note = groupNotes[gid] || ""
      const boundQQ = groupBinds[gid]
      groups.push({
        group_id: gid,
        group_name: note || info.group_name || info.name || gid,
        bound_qq: boundQQ || "",
      })
    }

    res.json({ users, groups })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 取消拉黑用户
Bot.express.delete(`${WEB_BASE}/api/bot/:selfId/blacklist/user`, async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    const { selfId } = req.params
    const { openid, unionid } = req.body || {}
    if (!openid) return res.status(400).json({ error: "缺少 openid" })
    const sep = Bot[selfId]?.adapter?.sep || ":"
    await unblUser(`${selfId}${sep}${openid}`, unionid || "")
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 取消拉黑群
Bot.express.delete(`${WEB_BASE}/api/bot/:selfId/blacklist/group`, async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    const { selfId } = req.params
    const { group_id } = req.body || {}
    if (!group_id) return res.status(400).json({ error: "缺少 group_id" })
    await unblGroup(group_id)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 拉黑用户（供 Web 端右键菜单使用）
Bot.express.post(`${WEB_BASE}/api/bot/:selfId/blacklist/user`, async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    const { selfId } = req.params
    const { openid, unionid } = req.body || {}
    if (!openid) return res.status(400).json({ error: "缺少 openid" })
    const sep = Bot[selfId]?.adapter?.sep || ":"
    await blUser(`${selfId}${sep}${openid}`, unionid || "")
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// 拉黑群（供 Web 端右键菜单使用）
Bot.express.post(`${WEB_BASE}/api/bot/:selfId/blacklist/group`, async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    const { selfId } = req.params
    const { group_id } = req.body || {}
    if (!group_id) return res.status(400).json({ error: "缺少 group_id" })
    await blGroup(String(group_id))
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ====== 群成员禁言（供 Web 端右键菜单使用） ======

// 禁言
Bot.express.post(`${WEB_BASE}/api/bot/:selfId/group/:groupId/mute`, async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    const { selfId, groupId } = req.params
    const { user_id, minutes } = req.body || {}
    if (!user_id || !minutes) return res.status(400).json({ error: "缺少 user_id 或 minutes" })
    const dur = parseInt(minutes, 10)
    if (!Number.isInteger(dur) || dur <= 0) return res.status(400).json({ error: "禁言时长必须为正整数（分钟）" })

    const bot = Bot[String(selfId)]
    if (!bot?.pickGroup) return res.status(400).json({ error: "Bot 未连接" })

    await bot.pickGroup(String(groupId)).muteMember(String(user_id), dur * 60)

    // 记录到 Redis，设置与禁言时长一致的过期时间
    const muteKey = `qqbot:mute:${groupId}:${user_id}`
    const r = bot.redis || redis
    if (r) {
      await r.set(muteKey, String(selfId))
      await r.expire(muteKey, dur * 60)
    }

    res.json({ ok: true })
  } catch (err) {
    logger.error("[web-mute]", err)
    res.status(500).json({ error: String(err?.message || err) })
  }
})

// 取消禁言
Bot.express.post(`${WEB_BASE}/api/bot/:selfId/group/:groupId/unmute`, async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    const { selfId, groupId } = req.params
    const { user_id } = req.body || {}
    if (!user_id) return res.status(400).json({ error: "缺少 user_id" })

    const bot = Bot[String(selfId)]
    if (!bot?.pickGroup) return res.status(400).json({ error: "Bot 未连接" })

    await bot.pickGroup(String(groupId)).unmuteMember(String(user_id))

    // 从 Redis 删除禁言记录
    const muteKey = `qqbot:mute:${groupId}:${user_id}`
    const r = bot.redis || redis
    if (r) await r.del(muteKey)

    res.json({ ok: true })
  } catch (err) {
    logger.error("[web-unmute]", err)
    res.status(500).json({ error: String(err?.message || err) })
  }
})

// 查询群内禁言用户列表
Bot.express.get(`${WEB_BASE}/api/bot/:selfId/group/:groupId/muted`, async (req, res) => {
  try {
    if (config.login?.enabled !== false && !(await getSession(req))) return res.status(401).json({ error: "未登录" })
    const { selfId, groupId } = req.params
    const muted = {}

    const r = (Bot[String(selfId)]?.redis) || redis
    if (r) {
      const pattern = `qqbot:mute:${groupId}:*`
      let cursor = "0"
      do {
        const reply = await r.scan(cursor, { MATCH: pattern, COUNT: 200 })
        cursor = reply.cursor
        if (reply.keys) {
          for (const k of reply.keys) {
            muted[k.split(":").pop()] = true
          }
        }
      } while (String(cursor) !== "0")
    }

    res.json({ ok: true, muted })
  } catch (err) {
    logger.error("[web-muted]", err)
    res.status(500).json({ error: String(err?.message || err) })
  }
})

logger.info(logger.green("QQBot Web 适配器 加载完成"))
logger.info(logger.green(`控制台地址：${Bot.url}${WEB_BASE}/`))
logger.info("-------------------------")

// 后台异步预计算 fastfetch 信息（不阻塞启动）
setTimeout(() => computeFastfetchInBackground(), 1000)

// ========== 全量群记录（原 plugins/example/全量数量.js，Web Adapter 依赖） ==========
const MAX_QL = 100

export class quanliang extends plugin {
  constructor() {
    super({
      name: "quanliang",
      dsc: "全量群记录",
      event: "message",
      priority: -100,
      rule: [
        { reg: "^#?全量(群)?(数量|列表)$", fnc: 'quanliang' },
        { reg: "^#?全部全量(群)?(数量|列表)$", fnc: 'allQuanliang' }
      ],
    })
  }
  async accept(e) {
    if (e.adapter_id !== "QQBot") return
    const selfId = e.self_id, groupId = e.group_id
    if (!selfId || !groupId) return
    if (e.raw_event?.t === 'GROUP_MESSAGE_CREATE') {
      let set = Bot.quanliangMap.get(selfId)
      if (!set) { set = new Set(); Bot.quanliangMap.set(selfId, set) }
      if (!set.has(groupId)) {
        set.add(groupId)
        await redis.sAdd(`wind-quanliang:${selfId}`, groupId)
        logger.info(`[全量记录] 新增群 ${groupId} -> 机器人 ${selfId}`)
      }
    }
  }
  formatGroupList(set, max = MAX_QL) {
    const list = Array.from(set), total = list.length
    if (total <= max) return { text: list.map(id => id.slice(11,16)+'***'+id.slice(-5)).join('\r'), total }
    return { text: list.map(id => id.slice(11,16)+'***'+id.slice(-5)).slice(0, max).join('\r'), total }
  }
  async quanliang(e) {
    if (e.adapter_id !== 'QQBot') return true
    if (!config.enableQuanliangCommands) return
    if (!e.isMaster) return
    const set = Bot.quanliangMap.get(e.self_id)
    if (!set?.size) return this.reply('当前机器人暂无全量群')
    const { text, total } = this.formatGroupList(set, MAX_QL)
    return this.reply(`***${Bot[e.self_id].nickname}***：共\`${total}个\`全量群\r` +
      (total > 100 ? '（仅展示前 100 个）' : '') + `\r\`\`\`群列表\r${text}\r\`\`\``)
  }
  async allQuanliang(e) {
    if (e.adapter_id !== 'QQBot') return true
    if (!config.enableQuanliangCommands) return
    if (!e.isMaster) return
    if (!Bot.quanliangMap.size) return this.reply('暂无全量群数据')
    let msg = ''
    for (const [selfId, set] of Bot.quanliangMap) {
      if (Bot.uin.includes(selfId)) {
        const { text, total } = this.formatGroupList(set, MAX_QL)
        if (total > 0) {
          msg += `***${Bot[selfId].nickname.replace('-测试中','')}***：共\`${total}个\`全量群\r`
          if (total > 100) msg += '（仅展示前 100 个）'
          msg += `\r\`\`\`群列表\r${text}\r\`\`\`\r`
        }
      }
    }
    return msg ? this.reply(msg.trim()) : this.reply('暂无全量群数据')
  }
}

export class outNotice extends plugin {
  constructor() {
    super({ name: "官机被踢", dsc: "官机被踢", event: "notice.group.decrease" })
  }
  async accept() {
    if (this.e.adapter_id !== 'QQBot') return true
    const selfId = this.e.self_id, groupId = this.e.group_id
    let set = Bot.quanliangMap.get(selfId)
    if (!set?.has(groupId)) return true
    set.delete(groupId)
    await redis.sRem(`wind-quanliang:${selfId}`, groupId)
    logger.info(`[全量记录] 移除群 ${groupId} <- 机器人 ${selfId}(机器人被踢)`)
  }
}
