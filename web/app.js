// ===== QQBot Web Adapter - Frontend App v2 (debug) =====

// 仅在 HTTPS 下启用 upgrade-insecure-requests，HTTP 访问时不动任何资源
if (location.protocol === "https:") {
  const meta = document.createElement("meta")
  meta.httpEquiv = "Content-Security-Policy"
  meta.content = "upgrade-insecure-requests"
  document.head.appendChild(meta)
}

// 动态计算 base path（从当前 URL 提取，例如 /qqbot-web → qqbot-web）
const WEB_BASE = (() => {
  const p = location.pathname.split('/').filter(Boolean)
  return '/' + (p[0] || 'qqbot-web')
})()
const API_BASE = `${WEB_BASE}/api`

// ===== 状态管理 =====
const state = {
  bots: [],
  currentBotId: null,
  currentBot: null,
  groups: [],
  currentGroupId: null,
  currentGroup: null,
  privateChats: [],
  privatePageSize: 20,
  privateOffset: 0,
  privateHasMore: true,
  privateLoading: false,
  privateTotal: 0,
  privateRendered: 0,
  currentPrivateUserId: null,
  currentPrivateUser: null,
  chatType: "group",  // "group" | "private"
  currentPage: "dashboard",
  messages: [],
  hasMore: true,
  isLoadingMore: false,
  oldestTimestamp: null,
  blacklist: { groups: [], openid: [], unionid: [] },
  oldestMsgIdx: null,
  messageType: "legacy",
  mdButtons: [],    // MD 消息按钮：二元数组，元素为 replacebutton 按钮对象
  replyTo: null, // { msg_idx, text }
  replyMsgId: null, // { message_id, text } 选中的消息 message_id 用于回复
  useReplyMsgId: false, // 是否自动使用最近一条 message_id 回复（默认值在切换聊天时动态设置）
  groupNotes: {},  // group_id → note 备注
  groupBindings: {}, // group_id → QQ群号
  boundGroupInfos: {}, // QQ群号 → { qq, group_name, member_count }
  groupMode: "active",  // "active" | "quanliang"
  allGroups: [],        // 全量群（活跃列表置顶时用于补充不在活跃列表的群）
  allGroupsBotId: null, // allGroups 对应的 bot，切换 bot 时失效
  pinnedGroups: [],     // 当前 bot 置顶的群 group_id
  pinnedPrivate: [],    // 当前 bot 置顶的私聊 user_id
  ws: null,        // WebSocket 连接
  wsReady: false,
  mobileChatActive: false,       // 移动端是否已推入 history state（用于返回键拦截）
  userInfoSource: null,         // 用户信息弹窗来源："chat" | "memberList"
  unreadCount: 0,              // 未读消息计数
  firstUnreadEl: null,         // 第一条未读消息的 DOM 元素引用（用于点击小球后定位）
  mutedUsers: {},              // 禁言用户缓存 { group_id: { user_id: true } }
}

// ===== DOM 引用缓存 =====
const $ = (sel, ctx = document) => ctx.querySelector(sel)
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)]

// ===== API 调用 =====
async function api(path, opts = {}) {
  const url = `${API_BASE}${path}`
  const res = await fetch(url, opts)
  if (res.status === 401) {
    // session 过期或未登录，跳转登录页
    window.location.replace(`${WEB_BASE}/login.html`)
    throw new Error("未登录")
  }
  if (!res.ok) {
    let msg
    try {
      const body = await res.text()
      try { msg = JSON.parse(body).error || body } catch { msg = body }
    } catch { msg = `HTTP ${res.status}` }
    throw new Error(msg)
  }
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    console.error("[api] 非JSON响应:", text.slice(0, 500))
    throw new Error(`响应解析失败: ${text.slice(0, 100)}`)
  }
}

// ===== 工具函数 =====
function formatSize(bytes) {
  if (bytes == null || isNaN(bytes)) return "0 B"
  if (bytes < 1024) return bytes + " B"
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB"
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB"
}
function isMobile() {
  return window.innerWidth <= 768
}

// 长按事件（移动端模拟右键菜单）
function addLongPress(el, callback) {
  let timer = null
  let lastTouch = null
  el.addEventListener("touchstart", (e) => {
    lastTouch = e.touches[0]
    timer = setTimeout(() => {
      timer = null
      // 标记长按已触发，阻止后续浏览器的原生 contextmenu
      window.__longPressed = true
      setTimeout(() => { window.__longPressed = false }, 800)
      // 构造包含 clientX/Y 的事件对象
      const fakeEvent = { clientX: lastTouch.clientX, clientY: lastTouch.clientY }
      callback(fakeEvent)
    }, 600)
  }, { passive: true })
  el.addEventListener("touchend", () => { if (timer) { clearTimeout(timer); timer = null } })
  el.addEventListener("touchmove", () => { if (timer) { clearTimeout(timer); timer = null } })
}

// ===== 头像懒加载（IntersectionObserver） =====
// 元素带 data-lazy-src 时，进入视口才真正加载头像；支持 <img>（设 src）与
// 带 data-lazy-bg 的 div（设 background-image）。加载失败时按 data-lazy-fallback 处理。
let _avatarObserver = null
function getAvatarObserver() {
  if (_avatarObserver) return _avatarObserver
  if (!("IntersectionObserver" in window)) {
    // 不支持时退化为立即加载
    _avatarObserver = {
      observe(el) { loadLazyAvatar(el) },
      unobserve() {},
      disconnect() {},
    }
    return _avatarObserver
  }
  _avatarObserver = new IntersectionObserver((entries, obs) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        loadLazyAvatar(entry.target)
        obs.unobserve(entry.target)
      }
    }
  }, { root: null, rootMargin: "200px", threshold: 0.01 })
  return _avatarObserver
}
function loadLazyAvatar(el) {
  const url = el.dataset.lazySrc
  if (!url) return
  if (el.dataset.lazyBg !== undefined) {
    el.style.backgroundImage = `url(${url})`
    el.dataset.lazySrc = ""
    return
  }
  // img 元素
  el.addEventListener("error", () => {
    const fb = el.dataset.lazyFallback
    if (fb !== undefined) {
      if (el.parentElement) el.outerHTML = fb
    } else {
      el.style.display = "none"
    }
  }, { once: true })
  el.src = url
  el.dataset.lazySrc = ""
}
// 渲染后批量观察列表/消息中的懒加载头像
function observeLazyAvatars(root = document) {
  const obs = getAvatarObserver()
  root.querySelectorAll("[data-lazy-src]").forEach(el => obs.observe(el))
}

// ===== 自定义扩展页面（开发者通过 webadapter/page.{js,json} 或 Bot.webAdapter 注册） =====
const webPagesMap = new Map()
const webPagesMounted = new Set()
// 记录当前处于「弹窗打开中」状态的自定义页面（由 iframe 通过 postMessage 上报）
const webPageModalState = new Set()

// 拉取自定义页面并动态生成侧边栏项与页面容器
async function loadWebPages() {
  try {
    const res = await fetch(`${API_BASE}/web-pages`)
    if (!res.ok) return
    const data = await res.json()
    const pages = Array.isArray(data.pages) ? data.pages : []
    const nav = document.querySelector(".sidebar-nav")
    const spacer = nav ? nav.querySelector(".sidebar-spacer") : null
    const content = document.getElementById("mainContent")
    for (const p of pages) {
      if (webPagesMap.has(p.id)) continue
      webPagesMap.set(p.id, p)

      if (nav) {
        const a = document.createElement("a")
        a.className = "nav-item"
        a.dataset.page = p.id
        a.href = `#${p.id}`
        const icon = document.createElement("span")
        icon.className = "nav-icon"
        icon.textContent = p.icon || "📄"
        const label = document.createElement("span")
        label.textContent = p.title
        a.appendChild(icon)
        a.appendChild(label)
        a.addEventListener("click", (e) => { e.preventDefault(); navigateTo(p.id) })
        if (spacer) nav.insertBefore(a, spacer)
        else nav.appendChild(a)
      }

      if (content) {
        const sec = document.createElement("section")
        sec.className = "page"
        sec.id = `page-${p.id}`
        content.appendChild(sec)
      }

      // 移动端「拓展」页：横幅列表
      const list = document.getElementById("extensionsList")
      if (list && !document.getElementById(`ext-${p.id}`)) {
        const card = document.createElement("div")
        card.className = "ext-banner"
        card.id = `ext-${p.id}`
        const ic = document.createElement("span")
        ic.className = "ext-icon"
        ic.textContent = p.icon || "📄"
        const ti = document.createElement("span")
        ti.className = "ext-title"
        ti.textContent = p.title
        const ar = document.createElement("span")
        ar.className = "ext-arrow"
        ar.textContent = "›"
        card.append(ic, ti, ar)
        card.addEventListener("click", () => navigateTo(p.id))
        list.appendChild(card)
      }
    }
    // 若当前 URL hash 指向某个自定义页面，进入后自动挂载
    const hash = location.hash.replace(/^#/, "")
    if (hash && webPagesMap.has(hash)) navigateTo(hash)
  } catch (e) {
    console.warn("[loadWebPages] 失败:", e)
  }
}

// 首次进入自定义页面时挂载内容（iframe 或注入 HTML）
function mountWebPage(page) {
  const def = webPagesMap.get(page)
  if (!def) return
  const container = document.getElementById(`page-${page}`)
  if (!container || webPagesMounted.has(page)) return
  webPagesMounted.add(page)
  if (def.type === "iframe") {
    const iframe = document.createElement("iframe")
    iframe.src = `${def.src}?__webBase=${encodeURIComponent(WEB_BASE)}`
    iframe.className = "web-page-iframe"
    container.appendChild(iframe)
  } else {
    container.innerHTML = def.html || ""
    if (def.style) {
      const link = document.createElement("link")
      link.rel = "stylesheet"
      link.href = def.style
      document.head.appendChild(link)
    }
    if (def.script) {
      const s = document.createElement("script")
      s.src = def.script
      s.async = true
      document.body.appendChild(s)
    }
  }
}

// ===== 页面导航 =====
let extReturnPage = null   // 进入「拓展区」前的页面，用于返回键离开后回到原处
let extDepth = 0           // 拓展区在当前历史栈中的层数（拓展列表 / 自定义页面 / 弹窗守卫）
let suppressPop = 0        // 需忽略的 popstate 次数（程序化 history.go 触发）

function navigateTo(page, opts = {}) {
  const pushHistory = opts.push !== false
  const prevPage = state.currentPage
  const inArea = (p) => webPagesMap.has(p) || p === "extensions"
  const wasInArea = inArea(prevPage)
  console.log("[navigateTo]", page, "currentBotId:", state.currentBotId)
  // 离开自定义页面时清理其弹窗状态
  if (webPagesMap.has(prevPage) && prevPage !== page) {
    webPageModalState.delete(prevPage)
  }
  state.currentPage = page

  // PC 侧边栏
  $$(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.page === page))
  $$(".page").forEach(el => el.classList.toggle("active", el.id === `page-${page}`))

  // 移动端底部导航（自定义页面归属「拓展」入口，保持高亮）
  $$(".mobile-nav-item").forEach(el => {
    const isActive = el.dataset.page === page || (webPagesMap.has(page) && el.dataset.page === "extensions")
    el.classList.toggle("active", isActive)
  })

  // 进入拓展区：逐层压入历史记录（拓展列表 / 自定义页面 / 弹窗守卫各一层）
  const enterArea = (sub) => {
    if (!isMobile() || !pushHistory) return
    if (extDepth === 0) extReturnPage = prevPage
    extDepth++
    history.pushState({ ext: true, sub, modal: false }, "", location.href)
  }

  // 自定义扩展页面
  if (webPagesMap.has(page)) {
    stopDashboardAutoRefresh()
    resetChatView()
    enterArea(page)
    mountWebPage(page)
    return
  }

  if (page === "extensions") {
    stopDashboardAutoRefresh()
    if (isMobile()) resetChatView()
    enterArea("extensions")
    return
  }

  // 离开拓展区（前往核心页面）：一次性弹掉拓展区的所有历史层
  if (wasInArea && isMobile() && pushHistory && extDepth > 0) {
    suppressPop += extDepth
    history.go(-extDepth)
    extDepth = 0
  }

  if (page === "messages") {
    stopDashboardAutoRefresh()
    if (isMobile()) {
      // 移动端切回群列表
      showMobileGroupList()
    }
    if (state.currentBotId) {
      console.log("[navigateTo] 触发 loadGroups, chatType:", state.chatType)
      if (state.chatType === "private") {
        loadPrivateChats()
      } else {
        loadGroups()
      }
    } else {
      console.warn("[navigateTo] 没有选中的 Bot，跳过 loadGroups")
    }
  } else if (page === "settings") {
    stopDashboardAutoRefresh()
    loadSettings()
    if (isMobile()) resetChatView()
  } else if (page === "blacklist") {
    stopDashboardAutoRefresh()
    loadBlacklist()
    if (isMobile()) resetChatView()
  } else {
    resetChatView()
    startDashboardAutoRefresh()
    // 移动端从消息切换到仪表盘：重置聊天状态
    if (isMobile() && (state.currentGroupId || state.currentPrivateUserId)) {
      const prevChatId = state.currentGroupId
      state.currentGroupId = null
      state.currentGroup = null
      state.currentPrivateUserId = null
      state.currentPrivateUser = null
      state.messages = []
      if (state.ws && state.wsReady && state.currentBotId) {
        if (state.chatType === "group") {
          state.ws.send(JSON.stringify({ type: "unwatch", selfId: state.currentBotId, groupId: prevChatId }))
        } else {
          state.ws.send(JSON.stringify({ type: "unwatch", selfId: state.currentBotId, privateUserId: prevChatId }))
        }
      }
    }
  }
}

function showMobileGroupList() {
  const groupList = $("#chatGroupList")
  const chatArea = $("#chatArea")
  const topbar = document.querySelector(".topbar")
  const mobileNav = $("#mobileNav")
  if (groupList) groupList.classList.remove("mobile-hidden")
  if (chatArea) chatArea.classList.add("mobile-hidden")
  if (topbar) topbar.classList.remove("mobile-hidden")
  if (mobileNav) mobileNav.classList.remove("mobile-hidden")
  state.mobileChatActive = false
}

function showMobileChat() {
  const groupList = $("#chatGroupList")
  const chatArea = $("#chatArea")
  const topbar = document.querySelector(".topbar")
  const mobileNav = $("#mobileNav")
  if (groupList) groupList.classList.add("mobile-hidden")
  if (chatArea) chatArea.classList.remove("mobile-hidden")
  if (topbar) topbar.classList.add("mobile-hidden")
  if (mobileNav) mobileNav.classList.add("mobile-hidden")
  // 推入浏览器历史，以便返回键退回到聊天列表而非离开网页
  if (isMobile() && !state.mobileChatActive) {
    state.mobileChatActive = true
    history.pushState({ mobileChat: true }, "", location.href)
  }
}

function resetChatView() {
  const groupList = $("#chatGroupList")
  const chatArea = $("#chatArea")
  const topbar = document.querySelector(".topbar")
  const mobileNav = $("#mobileNav")
  if (groupList) groupList.classList.remove("mobile-hidden")
  if (chatArea) chatArea.classList.remove("mobile-hidden")
  if (topbar) topbar.classList.remove("mobile-hidden")
  if (mobileNav) mobileNav.classList.remove("mobile-hidden")
  state.mobileChatActive = false
  refreshChatView()
}

// ===== Bot 选择 =====
async function loadBots() {
  console.log("[loadBots] 开始加载")
  try {
    state.bots = await api("/bots")
    console.log("[loadBots] 获取到", state.bots.length, "个Bot:", state.bots.map(b => b.self_id))
    renderBotSelector()
    renderBotDropdown()
    if (state.bots.length > 0 && !state.currentBotId) {
      console.log("[loadBots] 自动选择 Bot:", state.bots[0].self_id)
      selectBot(state.bots[0].self_id)
    }
  } catch (err) {
    console.error("加载 Bot 列表失败:", err)
    $("#currentBotNickname").textContent = "加载失败"
  }
}

function renderBotSelector() {
  const bot = state.currentBot
  const avatar = $("#currentBotAvatar")
  const nickname = $("#currentBotNickname")
  const qq = $("#currentBotQQ")

  if (bot) {
    avatar.src = bot.avatar || ""
    avatar.onerror = () => { avatar.src = "" }
    nickname.textContent = bot.nickname || bot.self_id
    qq.textContent = `BotQQ: ${bot.self_id}`
  } else {
    avatar.src = ""
    nickname.textContent = "选择 Bot"
    qq.textContent = ""
  }
}

function renderBotDropdown() {
  const dropdown = $("#botDropdown")
  dropdown.innerHTML = state.bots.map(bot => `
    <div class="bot-dropdown-item ${bot.self_id === state.currentBotId ? 'active' : ''}"
         data-bot-id="${bot.self_id}">
      <img class="bot-avatar" src="${bot.avatar || ''}" alt=""
           onerror="this.style.display='none'">
      <div class="bot-dd-info">
        <div class="bot-dd-nick">${escHtml(bot.nickname || bot.self_id)}</div>
        <div class="bot-dd-qq">BotQQ: ${bot.self_id}</div>
      </div>
      <div class="bot-dd-actions">
        <label class="bot-toggle" title="启用/关闭">
          <input type="checkbox" class="bot-toggle-input" data-action="toggle" data-bot-id="${bot.self_id}" ${bot.enabled !== false ? 'checked' : ''}>
          <span class="bot-toggle-slider"></span>
        </label>
        <button class="bot-del-btn" data-action="delete" data-bot-id="${bot.self_id}" title="删除 Bot">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
  `).join("") || '<div class="bot-dropdown-item" style="color:var(--text-muted)">没有可用的 Bot</div>'

  // 底部添加 Bot 入口
  dropdown.insertAdjacentHTML("beforeend", `
    <div class="bot-dropdown-add" id="botDropdownAddBtn">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      <span>添加 Bot</span>
    </div>
  `)
  const addItem = dropdown.querySelector("#botDropdownAddBtn")
  if (addItem) {
    addItem.addEventListener("click", () => {
      closeBotDropdown()
      $("#addBotBtn")?.click()
    })
  }

  dropdown.querySelectorAll(".bot-dropdown-item[data-bot-id]").forEach(el => {
    const id = el.dataset.botId
    el.addEventListener("click", (e) => {
      // 点击开关/删除按钮时不触发选择
      if (e.target.closest(".bot-toggle") || e.target.closest(".bot-del-btn")) return
      selectBot(id)
      closeBotDropdown()
    })

    const toggle = el.querySelector(".bot-toggle-input")
    if (toggle) {
      toggle.addEventListener("click", (e) => e.stopPropagation())
      toggle.addEventListener("change", async () => {
        const on = toggle.checked
        toggle.disabled = true
        try {
          if (on) {
            await api(`/bot/${id}/enable`, { method: "POST" })
            showToast(`已启用 Bot ${id}`)
          } else {
            await api(`/bot/${id}/disable`, { method: "POST" })
            showToast(`已关闭 Bot ${id}`)
          }
          await loadBots()
        } catch (err) {
          console.error("[bot toggle] 失败:", err)
          showToast(`操作失败：${err.message || err}`)
          toggle.checked = !on
        } finally {
          toggle.disabled = false
        }
      })
    }

    const delBtn = el.querySelector(".bot-del-btn")
    if (delBtn) {
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation()
        showConfirm(`确定删除 Bot ${id} 吗？\n将关闭连接并从配置文件中移除其 token。`, async (ok) => {
          if (!ok) return
          try {
            await api(`/bot/${id}/delete`, { method: "POST" })
            showToast(`已删除 Bot ${id}`)
            await loadBots()
            // 若删除的是当前 Bot，则清空选择
            if (state.currentBotId === id) {
              state.currentBotId = null
              state.currentBot = null
              reportSelectedBot("")
              renderBotSelector()
            }
          } catch (err) {
            console.error("[bot delete] 失败:", err)
            showToast(`删除失败：${err.message || err}`)
          }
        })
      })
    }
  })
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// ===== Toast 提示 =====
function showToast(msg) {
  const el = document.createElement("div")
  el.className = "toast-msg"
  el.textContent = msg
  document.body.appendChild(el)
  requestAnimationFrame(() => el.classList.add("show"))
  setTimeout(() => {
    el.classList.remove("show")
    setTimeout(() => el.remove(), 300)
  }, 2000)
}

// 通用确认弹窗：回调 (ok) => {}，ok 为 true 表示确认
function showConfirm(message, cb) {
  const overlay = document.createElement("div")
  overlay.className = "modal-overlay confirm-overlay show"
  overlay.innerHTML = `
    <div class="modal-content confirm-content">
      <div class="modal-header"><span>确认操作</span></div>
      <div class="confirm-body">${escHtml(message).replace(/\n/g, "<br>")}</div>
      <div class="confirm-actions">
        <button class="confirm-cancel">取消</button>
        <button class="confirm-ok">确定</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  const close = (ok) => {
    overlay.remove()
    try { cb(ok) } catch (e) { console.error(e) }
  }
  overlay.querySelector(".confirm-cancel").addEventListener("click", () => close(false))
  overlay.querySelector(".confirm-ok").addEventListener("click", () => close(true))
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false) })
}

// 角色徽章 HTML：群主（橙底白字）、管理员（绿底白字），群员不显示
function getRoleBadgeHtml(role) {
  if (!role || role === 'member') return ''
  if (role === 'owner') return ' <span class="role-badge role-badge-owner">群主</span>'
  if (role === 'admin') return ' <span class="role-badge role-badge-admin">管理员</span>'
  return ''
}

function toggleBotDropdown() {
  const dropdown = $("#botDropdown")
  const selector = $("#botSelector")
  const isOpen = dropdown.classList.contains("show")

  if (isOpen) {
    closeBotDropdown()
  } else {
    dropdown.classList.add("show")
    selector.classList.add("active")
  }
}

function closeBotDropdown() {
  $("#botDropdown").classList.remove("show")
  $("#botSelector").classList.remove("active")
}

// 将当前选中的 Bot 上报到后端会话（接口自动据此确定操作对象），失败静默
function reportSelectedBot(botId) {
  api("/select-bot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selfId: botId || "" })
  }).catch(() => {})
}

async function selectBot(botId) {
  console.log("[selectBot] botId:", botId, "currentPage:", state.currentPage)
  const prevChatId = state.chatType === "group" ? state.currentGroupId : state.currentPrivateUserId
  state.currentBotId = botId
  state.currentBot = state.bots.find(b => b.self_id === botId)
  // 上报到后端会话，供自定义页面（如菜单与面板）接口自动确定操作对象
  reportSelectedBot(botId)
  state.allGroups = []
  state.allGroupsBotId = null
  await loadPins()
  loadBlacklistData()
  state.currentGroupId = null
  state.currentGroup = null
  state.currentPrivateUserId = null
  state.currentPrivateUser = null
  state.messages = []
  state.hasMore = true
  state.oldestTimestamp = null
  state.oldestMsgIdx = null
  state.replyTo = null
  state.unreadCount = 0
  state.firstUnreadEl = null
  updateFloatGroup()
  stopAllMedia()

  // 取消旧 Bot 的 WebSocket 订阅
  if (state.ws && state.wsReady && prevChatId) {
    const msg = { type: "unwatch", selfId: state.currentBotId }
    if (state.chatType === "group") {
      msg.groupId = prevChatId
    } else {
      msg.privateUserId = prevChatId
    }
    state.ws.send(JSON.stringify(msg))
  }

  renderBotSelector()
  renderBotDropdown()
  updateDashboard()
  if (state.currentPage === "dashboard") startDashboardAutoRefresh()
  refreshChatView()

  // 移动端：显示群列表
  if (isMobile()) showMobileGroupList()

  if (state.currentPage === "messages") {
    console.log("[selectBot] 当前在消息页，触发 loadGroups")
    if (state.chatType === "private") {
      loadPrivateChats()
    } else {
      loadGroups()
    }
  }

  // 向所有已挂载的自定义页面 iframe 广播 Bot 切换，便于其同步刷新数据（如菜单与面板）
  broadcastToWebPages({ type: "bot-changed", selfId: botId })
}

// 向所有自定义页面 iframe 发送消息（iframe 自行决定刷新与否）
function broadcastToWebPages(msg) {
  $$(".web-page-iframe").forEach(iframe => {
    try { iframe.contentWindow && iframe.contentWindow.postMessage(msg, "*") } catch (e) {}
  })
}

// ===== 仪表盘 =====
let dashboardTimer = null

function startDashboardAutoRefresh() {
  stopDashboardAutoRefresh()
  dashboardTimer = setInterval(async () => {
    try {
      const sys = await api("/system-info")
      renderSystemInfo(sys)
    } catch { /* 静默忽略刷新错误 */ }
  }, 5000)
}

function stopDashboardAutoRefresh() {
  if (dashboardTimer) {
    clearInterval(dashboardTimer)
    dashboardTimer = null
  }
}

async function updateDashboard() {
  const placeholder = $("#dashboardPlaceholder")
  const content = $("#dashboardContent")

  if (!state.currentBot) {
    placeholder.style.display = "flex"
    content.style.display = "none"
    return
  }

  placeholder.style.display = "none"
  content.style.display = "block"

  // Bot 信息
  const bot = state.currentBot
  const avatarEl = $("#dashBotAvatar")
  if (avatarEl) {
    avatarEl.src = bot.avatar || ""
    avatarEl.onerror = () => { avatarEl.style.display = "none" }
    avatarEl.style.display = bot.avatar ? "" : "none"
  }
  $("#dashBotNickname").textContent = bot.nickname || bot.self_id
  $("#dashBotQQ").textContent = `QQ: ${bot.self_id}`
  $("#dashBotAppid").textContent = `AppID: ${bot.appid || "-"}`

  // 并行加载：活跃群、全量群、私聊、系统信息（互不依赖，同时发起）
  const [groupsR, allGroupsR, privatesR, sysR] = await Promise.allSettled([
    api(`/bot/${state.currentBotId}/groups`),
    api(`/bot/${state.currentBotId}/groups?type=quanliang`),
    api(`/bot/${state.currentBotId}/private-chats`),
    api("/system-info"),
  ])

  if (groupsR.status === "fulfilled") {
    $("#statGroupCount").textContent = groupsR.value.length
  } else {
    $("#statGroupCount").textContent = "-"
  }

  if (allGroupsR.status === "fulfilled") {
    $("#statQuanliangCount").textContent = allGroupsR.value.length
  } else {
    $("#statQuanliangCount").textContent = "-"
  }

  if (privatesR.status === "fulfilled") {
    $("#statPrivateCount").textContent = privatesR.value.length
  } else {
    $("#statPrivateCount").textContent = "-"
  }

  if (sysR.status === "fulfilled") {
    renderSystemInfo(sysR.value)
  } else {
    $("#dashBotUptime").textContent = "-"
    $("#statBotCount").textContent = "-"
    resetResourceInfo()
  }
}

function resetResourceInfo() {
  const ids = ["resCpuModel","resCpuCores","resCpuSpeed","resCpuTotal","resCpuProcess",
    "resMemTotal","resMemUsed","resMemProcess","ringCpuPct","ringMemPct",
    "verWebAdapter","verQQBotPlugin","verSystem"]
  ids.forEach(id => { const el = $("#"+id); if(el) el.textContent = "--" })
  // 重置磁盘
  const diskList = $("#diskList")
  if (diskList) {
    diskList.innerHTML = `<div class="dash-disk-item">
      <span class="dash-disk-name">-</span>
      <div class="dash-disk-bar-wrap">
        <div class="dash-disk-bar">
          <div class="dash-disk-fill" style="width:0%"></div>
        </div>
        <span class="dash-disk-pct">-</span>
      </div>
      <span class="dash-disk-detail">-</span>
    </div>`
  }
  // 重置系统信息
  const si = $("#dashSysInfo"); if(si) si.textContent = "获取中..."
  // 重置环形图（全部隐藏）
  const crb = $("#ringCpuBot"); if(crb) { crb.style.strokeDasharray = "0 314"; crb.style.strokeDashoffset = "0" }
  const cro = $("#ringCpuOther"); if(cro) { cro.style.strokeDasharray = "0 314"; cro.style.strokeDashoffset = "0" }
  const mrb = $("#ringMemBot"); if(mrb) { mrb.style.strokeDasharray = "0 314"; mrb.style.strokeDashoffset = "0" }
  const mro = $("#ringMemOther"); if(mro) { mro.style.strokeDasharray = "0 314"; mro.style.strokeDashoffset = "0" }
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 50 // r=50

function setRing(ringBotEl, ringOtherEl, botPct, totalPct) {
  // bot = 蓝色(本进程), other = 绿色(其他进程), 剩余 = 灰色背景(空闲)
  const bot = Math.max(0, Math.min(100, botPct || 0))
  const total = Math.max(0, Math.min(100, totalPct || 0))
  const other = Math.max(0, total - bot)

  // Bot 环：2 值（偶数），首值为 dash，从 0° 开始画 bot% 蓝色
  const botDash = RING_CIRCUMFERENCE * bot / 100
  ringBotEl.style.strokeDasharray = `${botDash} ${RING_CIRCUMFERENCE}`
  ringBotEl.style.strokeDashoffset = "0"

  // Other 环：4 值（偶数），dash-gap-dash-gap
  //   dash 0  → 不画
  //   gap gapBot → 跳过蓝色区域
  //   dash dashOther → 画绿色(其他进程)
  //   gap gapRest → 跳过空闲区域
  const gapBot = RING_CIRCUMFERENCE * bot / 100
  const dashOther = RING_CIRCUMFERENCE * other / 100
  const gapRest = RING_CIRCUMFERENCE * (1 - total / 100)
  ringOtherEl.style.strokeDasharray = `0 ${gapBot} ${dashOther} ${gapRest}`
  ringOtherEl.style.strokeDashoffset = "0"
}

function renderSystemInfo(sys) {
  // 在线时长
  if (sys.uptime != null) {
    $("#dashBotUptime").textContent = "在线 " + fmtUptime(sys.uptime)
  }
  // 版本信息
  if (sys.versions) {
    $("#verWebAdapter").textContent = sys.versions.webAdapter || "-"
    $("#verQQBotPlugin").textContent = sys.versions.qqbotPlugin || "-"
  }
  if (sys.system) {
    const s = sys.system
    $("#verSystem").textContent = `${s.platform || ""} ${s.release || ""} ${s.arch || ""}`.trim() || "-"
  }

  // CPU
  if (sys.cpu) {
    const cpu = sys.cpu
    $("#resCpuModel").textContent = cpu.model ? String(cpu.model).trim() : "-"
    $("#resCpuCores").textContent = cpu.cores != null ? `${cpu.cores} 核` : "-"
    // 主频转为 GHz
    if (cpu.speed != null) {
      const ghz = (cpu.speed / 1000).toFixed(2)
      $("#resCpuSpeed").textContent = `${ghz} GHz`
    } else {
      $("#resCpuSpeed").textContent = "-"
    }
    $("#resCpuTotal").textContent = cpu.usagePercent != null ? `${cpu.usagePercent}%` : "--"
    $("#resCpuProcess").textContent = cpu.processUsagePercent != null ? `${cpu.processUsagePercent}%` : "--"

    // 环形图
    const botCpu = cpu.processUsagePercent || 0
    const totalCpu = cpu.usagePercent || 0
    setRing($("#ringCpuBot"), $("#ringCpuOther"), botCpu, totalCpu)
    $("#ringCpuPct").textContent = totalCpu > 0 ? `${totalCpu}%` : "--"

    // tooltip
    const otherCpu = Math.max(0, totalCpu - botCpu)
    const idleCpu = Math.max(0, 100 - totalCpu)
    $("#ttCpuBot").textContent = botCpu.toFixed(1) + "%"
    $("#ttCpuOther").textContent = otherCpu.toFixed(1) + "%"
    $("#ttCpuIdle").textContent = idleCpu.toFixed(1) + "%"
  }

  // 内存
  if (sys.memory) {
    const mem = sys.memory
    $("#resMemTotal").textContent = fmtBytes(mem.total)
    $("#resMemUsed").textContent = fmtBytes(mem.used)
    $("#resMemProcess").textContent = mem.process != null ? fmtBytes(mem.process) : "-"

    // 进程内存占比
    const totalMemBytes = mem.total
    const processMemBytes = mem.process || 0
    const botMem = totalMemBytes > 0 ? (processMemBytes / totalMemBytes) * 100 : 0
    const totalMemPct = mem.usagePercent || 0
    setRing($("#ringMemBot"), $("#ringMemOther"), botMem, totalMemPct)
    $("#ringMemPct").textContent = totalMemPct > 0 ? `${totalMemPct}%` : "--"

    // tooltip
    const otherMem = Math.max(0, totalMemPct - botMem)
    const idleMem = Math.max(0, 100 - totalMemPct)
    $("#ttMemBot").textContent = botMem.toFixed(1) + "%"
    $("#ttMemOther").textContent = otherMem.toFixed(1) + "%"
    $("#ttMemIdle").textContent = idleMem.toFixed(1) + "%"
  }

  // 磁盘
  const diskList = $("#diskList")
  if (sys.disks && Array.isArray(sys.disks) && sys.disks.length > 0) {
    diskList.innerHTML = sys.disks.map(d => {
      const cls = d.usagePercent < 25 ? "low" : d.usagePercent < 75 ? "mid" : "high"
      return `<div class="dash-disk-item">
        <span class="dash-disk-name">${escHtml(d.mount || "?")}</span>
        <div class="dash-disk-bar-wrap">
          <div class="dash-disk-bar">
            <div class="dash-disk-fill ${cls}" style="width:${d.usagePercent || 0}%"></div>
          </div>
          <span class="dash-disk-pct">${d.usagePercent || 0}%</span>
        </div>
        <span class="dash-disk-detail">${fmtBytes(d.used)} / ${fmtBytes(d.total)}</span>
      </div>`
    }).join("")
  } else {
    diskList.innerHTML = `<div class="dash-disk-item">
      <span class="dash-disk-name">-</span>
      <div class="dash-disk-bar-wrap">
        <div class="dash-disk-bar"><div class="dash-disk-fill" style="width:0%"></div></div>
        <span class="dash-disk-pct">--</span>
      </div>
      <span class="dash-disk-detail">无法获取</span>
    </div>`
  }

  // 系统信息 (fastfetch)
  if (sys.fastfetch) {
    $("#dashSysInfo").innerHTML = sys.fastfetch
  } else {
    $("#dashSysInfo").textContent = "fastfetch 未安装或获取失败"
  }

  // Bot 数量
  $("#statBotCount").textContent = sys.botCount != null ? sys.botCount : "-"
}

function fmtBytes(bytes) {
  if (!bytes || bytes < 0) return "0 B"
  if (bytes < 1024) return bytes + " B"
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB"
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB"
}

function fmtUptime(seconds) {
  if (!seconds || seconds < 0) return "--"
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts = []
  if (d > 0) parts.push(`${d}天`)
  if (h > 0 || d > 0) parts.push(`${h}时`)
  parts.push(`${m}分`)
  return parts.join(" ")
}

// ===== 群列表 =====

/** 从 selfId:groupOpenid 格式中提取纯 groupOpenid */
function getPureGroupId(groupId) {
  if (!groupId) return ""
  const idx = groupId.indexOf(":")
  return idx !== -1 ? groupId.slice(idx + 1) : groupId
}

async function loadGroups() {
  if (!state.currentBotId) return
  const listEl = $("#groupListItems")
  loadPins()
  const mode = state.groupMode || "active"
  console.log("[loadGroups] 请求群列表, botId:", state.currentBotId, "mode:", mode)

  try {
    const [groups, notes, bindings] = await Promise.all([
      api(`/bot/${state.currentBotId}/groups?type=${mode}`),
      api(`/bot/${state.currentBotId}/group-notes`),
      api("/group-bindings"),
    ])
    state.groups = groups
    state.groupNotes = notes || {}
    state.groupBindings = bindings || {}
    console.log("[loadGroups] 获取到", state.groups.length, "个群,", Object.keys(state.groupNotes).length, "个备注,", Object.keys(state.groupBindings).length, "个绑定")
    // 加载绑定群的群信息（单次请求，无绑定则跳过）
    if (Object.keys(state.groupBindings).length) {
      await loadBoundGroupInfos()
    }
    // 活跃群列表下，若已置顶的群不在活跃列表，需从全量群列表补充，以便置顶展示
    if (state.groupMode !== "quanliang" && state.pinnedGroups.length) {
      await ensureAllGroups()
    }
    renderGroupList()
  } catch (err) {
    console.error("[loadGroups] 失败:", err)
    listEl.innerHTML = '<div class="group-list-empty">加载群列表失败</div>'
  }
}

// 单次请求获取全部绑定群的群信息
async function loadBoundGroupInfos() {
  try {
    const all = await api("/group-info/all")
    if (!all) return
    // all: { group_id: { qq, group_name, member_count } }
    for (const [, info] of Object.entries(all)) {
      if (info.qq && info.group_name) {
        state.boundGroupInfos[info.qq] = info
      }
    }
  } catch {}
}

// ===== 置顶（pin）功能 =====
// 置顶数据存储于后端（redis / sqlite，跟随设置中的存储方式），按 bot 区分

async function loadPins() {
  state.pinnedGroups = []
  state.pinnedPrivate = []
  if (!state.currentBotId) return
  try {
    const data = await api(`/pins?bot=${encodeURIComponent(state.currentBotId)}`)
    state.pinnedGroups = Array.isArray(data.groups) ? data.groups : []
    state.pinnedPrivate = Array.isArray(data.private) ? data.private : []
  } catch (e) {
    state.pinnedGroups = []
    state.pinnedPrivate = []
    console.error("[loadPins] 读取置顶失败:", e)
  }
}

async function _savePins(kind, arr) {
  if (kind === "groups") state.pinnedGroups = arr
  else state.pinnedPrivate = arr
  try {
    await api("/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot: state.currentBotId, kind, ids: arr }),
    })
  } catch (e) {
    showToast("保存置顶失败：" + e.message)
  }
}

function togglePinGroup(groupId) {
  const id = String(groupId)
  const arr = state.pinnedGroups
  const i = arr.indexOf(id)
  if (i >= 0) arr.splice(i, 1); else arr.push(id)
  _savePins("groups", arr)
}
function isGroupPinned(groupId) { return state.pinnedGroups.map(String).includes(String(groupId)) }

function togglePinPrivate(userId) {
  const id = String(userId)
  const arr = state.pinnedPrivate
  const i = arr.indexOf(id)
  if (i >= 0) arr.splice(i, 1); else arr.push(id)
  _savePins("private", arr)
}
function isPrivatePinned(userId) { return state.pinnedPrivate.map(String).includes(String(userId)) }

// 活跃群列表需要展示“不在活跃列表但已置顶”的群，需从全量群列表补充查找
async function ensureAllGroups() {
  if (state.allGroupsBotId === state.currentBotId && state.allGroups.length) return
  try {
    state.allGroups = await api(`/bot/${state.currentBotId}/groups?type=quanliang`)
    state.allGroupsBotId = state.currentBotId
  } catch (e) { state.allGroups = []; state.allGroupsBotId = state.currentBotId }
}

function renderGroupList() {
  const listEl = $("#groupListItems")
  const searchTerm = ($("#groupSearch")?.value || "").toLowerCase()

  const matchSearch = (g) => {
    const pureId = getPureGroupId(g.group_id)
    const note = state.groupNotes[g.group_id] || ""
    return g.group_name.toLowerCase().includes(searchTerm) ||
      pureId.toLowerCase().includes(searchTerm) ||
      note.toLowerCase().includes(searchTerm)
  }
  const baseFiltered = state.groups.filter(matchSearch)

  // 置顶项优先展示
  const pinSet = new Set(state.pinnedGroups.map(String))
  let pinnedItems = []
  if (state.groupMode === "quanliang") {
    // 全量群列表：仅展示“置顶且为全量群”
    pinnedItems = state.groups.filter(g => pinSet.has(String(g.group_id)))
  } else {
    // 活跃群列表：置顶项优先，且不管是否在活跃列表（从全量群列表补充查找）
    const allMap = new Map(state.allGroups.map(g => [String(g.group_id), g]))
    const seen = new Set()
    for (const gid of state.pinnedGroups) {
      const key = String(gid)
      if (seen.has(key)) continue
      seen.add(key)
      const g = state.groups.find(x => String(x.group_id) === key) || allMap.get(key)
      if (!g || !matchSearch(g)) continue
      pinnedItems.push(g)
    }
  }

  const pinnedIds = new Set(pinnedItems.map(g => String(g.group_id)))
  const normalItems = baseFiltered.filter(g => !pinnedIds.has(String(g.group_id)))
  const ordered = [...pinnedItems, ...normalItems]

  listEl.innerHTML = ordered.length
    ? ordered.map(g => {
        const pureId = getPureGroupId(g.group_id)
        const note = state.groupNotes[g.group_id]
        // 绑定群信息（用于无备注的绑定群）
        const qq = state.groupBindings[g.group_id]
        const boundInfo = qq ? state.boundGroupInfos[qq] : null
        let avatarChar = (pureId || "#")[0]
        let avatarHtml = `<div class="group-avatar group-avatar-clickable" data-group-id="${g.group_id}" title="查看群信息">${escHtml(avatarChar)}</div>`
        // 有绑定的群优先使用真实头像（懒加载）
        if (qq) {
          const avatarUrl = `http://p.qlogo.cn/gh/${qq}/${qq}/640`
          const fb = `<div class=\\'group-avatar group-avatar-clickable\\' data-group-id=\\'${g.group_id}\\'>${escHtml(avatarChar)}</div>`
          avatarHtml = `<img class="group-avatar-img group-avatar-clickable" data-group-id="${g.group_id}" data-lazy-src="${escHtml(avatarUrl)}" data-lazy-fallback="${fb}" alt="" title="查看群信息">`
        }
        let nameHtml
        if (note) {
          nameHtml = `<span class="group-note-badge">${escHtml(note)}</span>`
        } else if (boundInfo?.group_name) {
          nameHtml = `<div class="group-item-name">${escHtml(boundInfo.group_name)}</div>`
        } else if (qq) {
          nameHtml = `<div class="group-item-name">QQ群:${escHtml(qq)}</div>`
        } else {
          nameHtml = `<div class="group-item-name">${escHtml(g.group_name || pureId)}</div>`
        }
        const isPinned = pinnedIds.has(String(g.group_id))
        const blBadge = g.is_blacklisted ? '<span class="blacklist-badge">拉黑</span>' : ''
        return `
        <div class="group-list-item ${g.group_id === state.currentGroupId && state.chatType === "group" ? 'active' : ''}${isPinned ? ' pinned' : ''}"
             data-group-id="${g.group_id}">
          ${avatarHtml}
          <div class="group-item-info">
            <div class="group-item-name-row">${nameHtml}${blBadge}</div>
            <div class="group-item-id">${escHtml(pureId)}</div>
          </div>
        </div>
      `}).join("")
    : '<div class="group-list-empty">暂无群聊</div>'

  listEl.querySelectorAll(".group-list-item[data-group-id]").forEach(el => {
    el.addEventListener("click", () => selectGroup(el.dataset.groupId))
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault()
      showGroupContextMenu(e, el.dataset.groupId)
    })
    // 移动端长按 → 群右键菜单
    addLongPress(el, (e) => showGroupContextMenu(e, el.dataset.groupId))
  })

  // 群头像点击 → 查看群信息（阻止冒泡，避免触发 selectGroup）
  listEl.querySelectorAll(".group-avatar-clickable[data-group-id]").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation()
      showGroupInfoModal(el.dataset.groupId)
    })
  })

  // 懒加载群头像
  observeLazyAvatars(listEl)

  // 若仍有群名是兜底 id（后端正在异步补取群名），稍后自动刷新一次群列表
  const hasPending = state.groups.some(g => {
    const pureId = getPureGroupId(g.group_id)
    return g.group_name === g.group_id || g.group_name === pureId
  })
  if (hasPending && !state._pendingGroupRefresh) {
    state._pendingGroupRefresh = true
    setTimeout(() => {
      state._pendingGroupRefresh = false
      if (state.currentView === "messages") loadGroups()
    }, 2000)
  }
}

async function selectGroup(groupId) {
  console.log("[selectGroup] groupId:", groupId)

  // 取消旧订阅
  if (state.ws && state.wsReady && state.currentBotId) {
    const oldChatId = state.chatType === "group" ? state.currentGroupId : state.currentPrivateUserId
    if (oldChatId && oldChatId !== groupId) {
      const msg = { type: "unwatch", selfId: state.currentBotId }
      if (state.chatType === "group") {
        msg.groupId = oldChatId
      } else {
        msg.privateUserId = oldChatId
      }
      state.ws.send(JSON.stringify(msg))
    }
  }

  state.chatType = "group"
  state.currentGroupId = groupId
  state.currentPrivateUserId = null
  state.currentPrivateUser = null
  state.currentGroup = state.groups.find(g => g.group_id === groupId) || { group_id: groupId, group_name: groupId }
  state.messages = []
  state.hasMore = true
  state.oldestTimestamp = null
  state.oldestMsgIdx = null
  state.replyTo = null
  state.replyMsgId = null
  state.replyEventId = null
  // 活跃群非全量/私聊默认开启 message_id 回复，全量群默认关闭
  state.useReplyMsgId = state.chatType === "private" ? true : (state.groupMode !== "quanliang")
  state.unreadCount = 0
  state.firstUnreadEl = null
  updateFloatGroup()
  stopAllMedia()

  try {
    renderGroupList()
    updateReplyPreview()
    updateMsgIdReplyPreview()
    openChat(groupId)
    loadMutedUsers()
    // 移动端切到聊天视图
    if (isMobile()) showMobileChat()
    // 订阅新群
    if (state.ws && state.wsReady && state.currentBotId) {
      state.ws.send(JSON.stringify({
        type: "watch", selfId: state.currentBotId, groupId: groupId,
      }))
    }
  } catch (err) {
    console.error("[selectGroup] UI 更新错误:", err)
  }

  console.log("[selectGroup] 开始 loadMessages, currentGroupId:", state.currentGroupId)
  try {
    await loadMessages()
  } catch (err) {
    console.error("[selectGroup] loadMessages 出错:", err)
  }
}

// ===== 私聊列表 =====
async function loadPrivateChats(reset = true) {
  if (!state.currentBotId || state.privateLoading) return
  const listEl = $("#groupListItems")

  // 重置分页
  if (reset) {
    state.privateChats = []
    state.privateOffset = 0
    state.privateHasMore = true
    state.privateTotal = 0
    listEl.innerHTML = '<div class="group-list-empty">加载中…</div>'
    removePrivateSentinel()
  }

  // 没有更多则不请求
  if (!state.privateHasMore) return

  state.privateLoading = true
  try {
    const data = await api(`/bot/${state.currentBotId}/private-chats?offset=${state.privateOffset}&limit=${state.privatePageSize}`)
    const users = Array.isArray(data.users) ? data.users : []
    state.privateChats.push(...users)
    state.privateOffset += users.length
    state.privateTotal = typeof data.total === "number" ? data.total : state.privateOffset
    state.privateHasMore = !!data.hasMore
    renderPrivateChatList()
  } catch (err) {
    console.error("[loadPrivateChats] 失败:", err)
    if (reset) listEl.innerHTML = '<div class="group-list-empty">加载私聊列表失败</div>'
  } finally {
    state.privateLoading = false
  }
}

// 私聊列表滚动到底部自动加载下一页（IntersectionObserver 哨兵）
let _privateSentinelObserver = null
function ensurePrivateSentinel() {
  const listEl = $("#groupListItems")
  if (!listEl) return
  // 已存在则跳过
  if (listEl.querySelector(".private-sentinel")) return
  const sentinel = document.createElement("div")
  sentinel.className = "private-sentinel"
  sentinel.style.height = "1px"
  listEl.appendChild(sentinel)

  if (!_privateSentinelObserver) {
    _privateSentinelObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          // 还有更多且未在加载时，自动加载下一页
          if (state.privateHasMore && !state.privateLoading) {
            loadPrivateChats(false)
          }
        }
      }
    }, { root: listEl, rootMargin: "120px", threshold: 0 })
  }
  _privateSentinelObserver.observe(sentinel)
}
function removePrivateSentinel() {
  const listEl = $("#groupListItems")
  if (!listEl) return
  const s = listEl.querySelector(".private-sentinel")
  if (s) s.remove()
}

function privateChatItemHtml(u, pinSet) {
  const avatarLazy = u.avatar
    ? `data-lazy-src="${escHtml(u.avatar)}" data-lazy-bg`
    : ""
  const avatarInner = u.avatar ? '' : escHtml((u.nickname || String(u.user_id))[0])
  const isPinned = pinSet.has(String(u.user_id))
  const blBadge = u.is_blacklisted ? '<span class="blacklist-badge">拉黑</span>' : ''
  const safeOpenid = escHtml(u.openid || "")
  const safeUnionid = escHtml(u.unionid || "")
  return `
  <div class="group-list-item ${String(u.user_id) === state.currentPrivateUserId && state.chatType === "private" ? 'active' : ''}${isPinned ? ' pinned' : ''}"
       data-user-id="${String(u.user_id)}"
       data-openid="${safeOpenid}"
       data-unionid="${safeUnionid}">
    <div class="group-avatar user-avatar" ${avatarLazy}>${avatarInner}</div>
      <div class="group-item-info">
        <div class="group-item-name-row"><div class="group-item-name">${escHtml(u.nickname || String(u.user_id))}</div>${blBadge}</div>
        <div class="group-item-id">${escHtml(String(u.user_id))}</div>
      </div>
    </div>
  `
}

// ordered：已过滤+排序后的私聊数组；start/end：本次要渲染的切片；container：用于监听头像的临时容器
function appendPrivateItems(ordered, start, end, container) {
  const pinSet = new Set(state.pinnedPrivate.map(String))
  const slice = ordered.slice(start, end)
  container.innerHTML = slice.map(u => privateChatItemHtml(u, pinSet)).join("")
  container.querySelectorAll(".group-list-item[data-user-id]").forEach(el => {
    el.addEventListener("click", () => selectPrivateChat(el.dataset.userId))
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault()
      showPrivateUserContextMenu(e, el.dataset.userId, el.dataset.openid, el.dataset.unionid)
    })
    // 移动端长按 → 私聊用户右键菜单
    addLongPress(el, (e) => showPrivateUserContextMenu(e, el.dataset.userId, el.dataset.openid, el.dataset.unionid))
    // 点击头像 → 用户信息弹窗
    const avatarDiv = el.querySelector(".group-avatar.user-avatar")
    if (avatarDiv) {
      avatarDiv.addEventListener("click", (e) => {
        e.stopPropagation()
        const user = state.privateChats.find(u => String(u.user_id) === String(el.dataset.userId))
        if (user) showUserInfoModal(user, "chat")
      })
    }
  })
  return container
}

function renderPrivateChatList(reset = true) {
  const listEl = $("#groupListItems")
  const searchTerm = ($("#groupSearch")?.value || "").toLowerCase()

  const matchSearch = (u) =>
    String(u.user_id).toLowerCase().includes(searchTerm) ||
    (u.nickname || "").toLowerCase().includes(searchTerm)

  const base = state.privateChats.filter(matchSearch)

  // 置顶私聊优先展示（不管是否在活跃列表，只要置顶即可）
  const pinSet = new Set(state.pinnedPrivate.map(String))
  const pinnedItems = base.filter(u => pinSet.has(String(u.user_id)))
  const normalItems = base.filter(u => !pinSet.has(String(u.user_id)))
  const ordered = [...pinnedItems, ...normalItems]

  if (reset) {
    state.privateRendered = 0
    // 移除哨兵，稍后按需重建
    removePrivateSentinel()
    listEl.innerHTML = ordered.length ? "" : '<div class="group-list-empty">暂无私聊</div>'
  }

  if (ordered.length === 0) return

  // 仅渲染尚未渲染过的部分（追加，不重置滚动）
  const start = state.privateRendered
  if (start >= ordered.length) {
    updatePrivateSentinel()
    return
  }

  const tmp = document.createElement("div")
  appendPrivateItems(ordered, start, ordered.length, tmp)
  while (tmp.firstChild) listEl.appendChild(tmp.firstChild)

  state.privateRendered = ordered.length

  // 懒加载私聊头像（仅本次新增部分）
  observeLazyAvatars(listEl)

  // 根据是否还有更多页管理自动加载哨兵
  updatePrivateSentinel()
}

// 维护“滚动到底自动加载”的哨兵：还有更多则确保哨兵存在，否则移除
function updatePrivateSentinel() {
  if (state.privateHasMore) {
    ensurePrivateSentinel()
  } else {
    removePrivateSentinel()
  }
}

async function selectPrivateChat(userId) {
  console.log("[selectPrivateChat] userId:", userId)

  // 取消旧订阅
  if (state.ws && state.wsReady && state.currentBotId) {
    const oldChatId = state.chatType === "group" ? state.currentGroupId : state.currentPrivateUserId
    if (oldChatId && oldChatId !== userId) {
      const msg = { type: "unwatch", selfId: state.currentBotId }
      if (state.chatType === "group") {
        msg.groupId = oldChatId
      } else {
        msg.privateUserId = oldChatId
      }
      state.ws.send(JSON.stringify(msg))
    }
  }

  state.chatType = "private"
  state.currentPrivateUserId = userId
  state.currentGroupId = null
  state.currentGroup = null
  state.currentPrivateUser = state.privateChats.find(u => String(u.user_id) === String(userId)) || { user_id: userId, nickname: userId }
  state.messages = []
  state.hasMore = true
  state.oldestTimestamp = null
  state.oldestMsgIdx = null
  state.replyTo = null
  state.replyMsgId = null
  state.replyEventId = null
  // 私聊默认开启 message_id 回复
  state.useReplyMsgId = true
  state.unreadCount = 0
  state.firstUnreadEl = null
  updateFloatGroup()
  stopAllMedia()

  try {
    renderPrivateChatList()
    updateReplyPreview()
    updateMsgIdReplyPreview()
    openChat(userId)
    if (isMobile()) showMobileChat()
    // 订阅新私聊
    if (state.ws && state.wsReady && state.currentBotId) {
      state.ws.send(JSON.stringify({
        type: "watch", selfId: state.currentBotId, privateUserId: userId,
      }))
    }
  } catch (err) {
    console.error("[selectPrivateChat] UI 更新错误:", err)
  }

  try {
    await loadMessages()
  } catch (err) {
    console.error("[selectPrivateChat] loadMessages 出错:", err)
  }
}

// ===== 聊天界面 =====
function openChat(groupId) {
  const empty = $("#chatEmpty")
  const header = $("#chatHeader")
  const inputArea = $("#chatInputArea")
  const messagesContainer = $("#chatMessages")

  console.log("[openChat] empty:", !!empty, "header:", !!header, "inputArea:", !!inputArea, "messagesContainer:", !!messagesContainer)
  if (empty) empty.style.display = "none"
  if (header) header.style.display = "flex"
  if (inputArea) inputArea.style.display = "block"
  if (messagesContainer) {
    messagesContainer.querySelectorAll(".msg-item, .messages-no-more").forEach(el => el.remove())
  }

  const nameEl = $("#chatHeaderName")
  const idEl = $("#chatHeaderId")

  if (state.chatType === "private") {
    if (nameEl) nameEl.textContent = state.currentPrivateUser?.nickname || String(groupId)
    if (idEl) idEl.textContent = String(groupId)
    const infoBtn = $("#chatHeaderInfoBtn")
    if (infoBtn) infoBtn.classList.remove("show")
  } else {
    const note = state.groupNotes[groupId]
    const pureId = getPureGroupId(groupId)
    // 优先备注，其次绑定群真实名称，再回退到 group_name
    let displayName = note
    if (!displayName) {
      const qq = state.groupBindings[groupId]
      const boundInfo = qq ? state.boundGroupInfos[qq] : null
      displayName = boundInfo?.group_name || state.currentGroup?.group_name || pureId
    }
    if (nameEl) nameEl.textContent = displayName
    if (idEl) idEl.textContent = pureId
    const infoBtn = $("#chatHeaderInfoBtn")
    if (infoBtn) infoBtn.classList.add("show")
  }
}

function refreshChatView() {
  const empty = $("#chatEmpty")
  const header = $("#chatHeader")
  const inputArea = $("#chatInputArea")
  const messagesContainer = $("#chatMessages")

  const hasActiveChat = state.chatType === "group" ? state.currentGroupId : state.currentPrivateUserId
  if (!hasActiveChat) {
    if (empty) empty.style.display = "flex"
    if (header) header.style.display = "none"
    if (inputArea) inputArea.style.display = "none"
    if (messagesContainer) {
      messagesContainer.querySelectorAll(".msg-item, .messages-no-more").forEach(el => el.remove())
    }
    // 没有活跃聊天时重置未读
    state.unreadCount = 0
    state.firstUnreadEl = null
    updateFloatGroup()
    // PC 端恢复群列表显示
    if (!isMobile()) {
      const groupList = $("#chatGroupList")
      const chatArea = $("#chatArea")
      if (groupList) groupList.classList.remove("mobile-hidden")
      if (chatArea) chatArea.classList.remove("mobile-hidden")
    }
  }
}

async function loadMessages(before, append = false) {
  console.log("[loadMessages] 调用, before:", before, "append:", append, "chatType:", state.chatType)
  if (state.isLoadingMore) { console.log("[loadMessages] 已在加载中,跳过"); return }
  const chatId = state.chatType === "group" ? state.currentGroupId : state.currentPrivateUserId
  if (!chatId) { console.warn("[loadMessages] chatId为null,跳过"); return }
  state.isLoadingMore = true

  const container = $("#chatMessages")
  const loadIndicator = $("#loadMoreIndicator")
  const noMoreEl = $("#noMoreMessages")

  // 构建 before 参数：优先用 msg_idx 精确定位，回退到 timestamp
  let beforeParam = null
  if (!append) {
    // 初始加载：不需要 before 参数（加载最新消息）
    beforeParam = null
  } else if (state.oldestMsgIdx) {
    // 有 msg_idx：用 JSON 对象格式传递精确定位
    beforeParam = JSON.stringify({ msg_idx: state.oldestMsgIdx, timestamp: state.oldestTimestamp })
  } else if (state.oldestTimestamp) {
    // 回退：仅传 timestamp
    beforeParam = state.oldestTimestamp
  }

  if (!append) {
    // 清除消息前先停止正在播放的媒体
    stopAllMedia()
    // 只清除消息条目，保留 indicator 元素
    container.querySelectorAll(".msg-item, .messages-no-more").forEach(el => el.remove())
    if (noMoreEl) noMoreEl.style.display = "none"
    // 初始加载：重置未读计数
    state.unreadCount = 0
    state.firstUnreadEl = null
    updateFloatGroup()
  }
  if (loadIndicator) loadIndicator.style.display = append ? "flex" : "none"

  try {
    const limit = 20
    const params = new URLSearchParams({ limit })
    if (beforeParam) params.set("before", beforeParam)

    const prefix = state.chatType === "group" ? "group" : "private"
    const url = `/bot/${state.currentBotId}/${prefix}/${chatId}/messages?${params}`
    console.log("[loadMessages] 请求URL:", url, "beforeParam:", beforeParam)
    const newMessages = await api(url)

    state.hasMore = newMessages.length >= limit

    if (newMessages.length > 0) {
      if (append) {
        // 向上追加旧消息
        const oldScrollHeight = container.scrollHeight
        renderMessages(newMessages, "afterbegin")
        // 恢复滚动位置
        requestAnimationFrame(() => {
          container.scrollTop = container.scrollHeight - oldScrollHeight
        })
        // API 返回升序（旧→新），append 的旧消息放在 state.messages 前面
        state.messages = [...newMessages, ...state.messages]
      } else {
        renderMessages(newMessages, "beforeend")
        scrollToBottom()
        // 初始加载：API 返回升序（旧→新），直接存入 state.messages
        state.messages = [...newMessages]
      }

      // 更新最早消息的游标（用于下次加载更多）
      const oldest = newMessages[0]
      state.oldestTimestamp = oldest.timestamp
      state.oldestMsgIdx = oldest.msg_idx || null
    }

    if (!append && newMessages.length === 0) {
      const emptyDiv = document.createElement("div")
      emptyDiv.className = "messages-no-more"
      emptyDiv.textContent = "暂无消息记录"
      emptyDiv.style.marginTop = "40px"
      container.appendChild(emptyDiv)
    }

    // 更新"没有更多"提示
    if (!state.hasMore && container.querySelector(".messages-no-more") === null) {
      const noMore = document.createElement("div")
      noMore.className = "messages-no-more"
      noMore.textContent = "没有更多消息了"
      noMore.id = "noMoreMessages"
      container.insertBefore(noMore, container.firstChild)
    }
  } catch (err) {
    console.error("加载消息失败:", err)
  } finally {
    state.isLoadingMore = false
    if (loadIndicator) loadIndicator.style.display = "none"
  }
}

// 解析文本中的 <faceType=...>（删除）和 <attachmentType=...>（替换为内联媒体）
// inlineTracker 收集已内联渲染的附件索引，避免在 attachmentHtml 中重复显示
function renderTextWithInlineMedia(text, attachments, inlineTracker) {
  if (!text || typeof text !== 'string') return ''
  const parts = []
  let lastIndex = 0
  const tagRegex = /<(faceType|attachmentType)=([^>]*)>/g
  let match

  while ((match = tagRegex.exec(text)) !== null) {
    // 标签前的纯文本 → 转义
    if (match.index > lastIndex) {
      parts.push(escHtml(text.slice(lastIndex, match.index)))
    }

    const tagType = match[1]        // "faceType" 或 "attachmentType"
    const tagBody = match[2]        // 参数部分

    if (tagType === "faceType") {
      // 表情标签：直接移除，不做任何渲染
    } else if (tagType === "attachmentType") {
      if (attachments) {
        const idxMatch = tagBody.match(/attachmentIndex=(\d+)/)
        if (idxMatch) {
          const idx = parseInt(idxMatch[1])
          const att = attachments[idx]
          if (att) {
            inlineTracker.add(idx)
            const mime = att.content_type || ''
            const url = escHtml(att.url || '')
            if (mime.startsWith('image/')) {
              parts.push(`<img src="${url}" class="msg-inline-media" onclick="window.open(this.src)" />`)
            } else if (mime.startsWith('video/')) {
              parts.push(`<video src="${url}" controls class="msg-inline-media"></video>`)
            } else if (mime.startsWith('audio/') || mime.startsWith('voice/') || mime === 'voice') {
              parts.push(`<audio src="${url}" controls></audio>`)
            } else {
              const fName = escHtml(att.filename || '下载文件')
              parts.push(`<a href="${url}" download="${fName}" class="msg-file-link">${fName}</a>`)
            }
          }
        }
      }
      // 无论 attachments 是否可用，attachmentType 标签都会被跳过（通过 lastIndex 更新）
    }

    lastIndex = tagRegex.lastIndex
  }

  // 尾部纯文本
  if (lastIndex < text.length) {
    parts.push(escHtml(text.slice(lastIndex)))
  }

  return parts.join('')
}

// ===== QQBot Markdown 解析器 =====
function parseQqbotMarkdown(text, attachments, inlineTracker) {
  if (!text || typeof text !== 'string') return ''

  // ===== 归一化换行符 =====
  text = text.replace(/\r\n?/g, '\n')
  text = text.replace(/\n{3,}/g, '\n\n')

  // ===== 保护阶段：提取所有特殊语法，替换为占位符，防止后续被破坏 =====

  // Step 0: 提取内联媒体标签 (faceType/attachmentType)
  const inlineTagRegex = /<(faceType|attachmentType)=([^>]*)>/g
  const tags = []
  text = text.replace(inlineTagRegex, (match, tagType, tagBody) => {
    const ph = `\x00INLINE${tags.length}\x00`
    tags.push({ tagType, tagBody })
    return ph
  })

  // Step 0.5: 提取 <@openid> 提及 → 占位符（在 escHtml 之前保护）
  const atMentions = []
  text = text.replace(/<@([A-Fa-f0-9]+)>/g, (match, uid) => {
    const ph = `\x00AT${atMentions.length}\x00`
    const nick = _mentionNickCache[uid] || uid
    atMentions.push(`<span class="msg-at-capsule" data-at-uid="${escHtml(uid)}" data-at-nick="${escHtml(nick)}" title="点击@${escHtml(nick)}">@${escHtml(nick)}</span>`)
    return ph
  })

  // Step 1: 提取代码块（```...```）— 必须在行内代码之前！
  // 代码块两种格式：
  //   多行：```lang\r\ncode\r\n```
  //   单行：```code``` （无换行，无lang）
  const codeBlocks = []
  // 1a. 多行代码块：``` lang \r\n code \r\n ```
  text = text.replace(/(`{3,})\s*([^\r\n`]*)[\r\n]+([\s\S]*?)\1/g, (_, ticks, lang, code) => {
    const ph = `\x00CODE${codeBlocks.length}\x00`
    codeBlocks.push({ lang: lang.trim() || '', code: escHtml(code.replace(/[\r\n]+$/, '')) })
    return ph
  })
  // 1b. 单行代码块：```code``` （两个```之间没有换行符）
  text = text.replace(/(`{3,})([^\r\n`]+)\1/g, (_, ticks, content) => {
    const ph = `\x00CODE${codeBlocks.length}\x00`
    codeBlocks.push({ lang: '', code: escHtml(content) })
    return ph
  })

  // Step 2: 提取行内代码（`...`）— 代码块已占位，剩下的`才是行内代码
  const inlineCodes = []
  text = text.replace(/`([^`\r\n]+)`/g, (_, code) => {
    const ph = `\x00ICODE${inlineCodes.length}\x00`
    inlineCodes.push(`<span class="md-inline-code">${escHtml(code)}</span>`)
    return ph
  })

  // Step 3: 提取 MD 图片 ![alt](url) — 允许 ! 和 [ 之间有空白，] 和 ( 之间有空格
  const imgs = []
  text = text.replace(/!\s*\[([^\]]*)\]\s*\(([^)]+)\)/g, (_, alt, url) => {
    const cleanAlt = alt.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
    const cleanUrl = url.replace(/[\r\n]/g, '').replace(/\s+/g, '').trim()
    if (!cleanUrl) return _
    const ph = `\x00IMG${imgs.length}\x00`
    imgs.push(renderMdImage(cleanAlt, cleanUrl))
    return ph
  })

  // Step 4: 提取 mqqapi 链接 [text](mqqapi://...)
  const mqqs = []
  text = text.replace(/\[([^\]]*)\]\s*\((mqqapi:\/\/[^)]+)\)/g, (_, label, url) => {
    const cleanUrl = url.replace(/[\r\n]/g, '').replace(/\s+/g, '').trim()
    const cleanLabel = label.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
    const ph = `\x00MQQ${mqqs.length}\x00`
    mqqs.push(renderMqqapi(cleanLabel, cleanUrl))
    return ph
  })

  // Step 5: 提取普通链接 [text](url)
  const links = []
  text = text.replace(/\[([^\]]+)\]\s*\((https?:\/\/[^)]+)\)/g, (_, label, url) => {
    const cleanUrl = url.replace(/[\r\n]/g, '').replace(/\s+/g, '').trim()
    const cleanLabel = label.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
    const ph = `\x00LINK${links.length}\x00`
    links.push(`<a href="${escHtml(cleanUrl)}" target="_blank" class="md-link">${cleanLabel}</a>`)
    return ph
  })

  // Step 6: 提取 LaTeX 公式块 $$...$$
  const texBlocks = []
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => {
    const ph = `\x00TEXBLOCK${texBlocks.length}\x00`
    texBlocks.push(tex.trim())
    return ph
  })

  // Step 7: 按段落处理 — 连续非空非块级行累加为同一段落，用 <br> 连接
  const lines = text.split(/\n/)
  const out = []
  let inTable = false
  let paraBuf = [] // 段落缓冲：累加连续普通行

  function flushPara() {
    if (paraBuf.length === 0) return
    out.push(`<p class="md-p">${paraBuf.join('<br>')}</p>`)
    paraBuf = []
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw === '\u200B' || raw === '\u200B\u200B') {
      paraBuf.push('<br>')
      continue
    }

    const line = raw.trim()

    // 代码块占位符 → 直接输出，不进入段落缓冲
    if (/^\x00CODE\d+\x00$/.test(line)) {
      flushPara()
      out.push(line)
      continue
    }

    // 空行：结束当前段落
    if (line === '') {
      flushPara()
      out.push('<br>')
      continue
    }

    // mqqapi 协议行
    if (/^\[?\]?\(?mqqapi:\/\//.test(line)) {
      paraBuf.push(parseInline(line, tags, codeBlocks, texBlocks))
      continue
    }

    // 水平分割线
    if (/^\s*\*{3,}\s*$/.test(line)) { flushPara(); out.push('<hr class="md-hr">'); continue }

    // 标题 # text 或 #text (1到3级)
    const hMatch = line.match(/^(#{1,3})([^#].*)/)
    if (hMatch) {
      flushPara()
      const lvl = hMatch[1].length
      const txt = parseInline(hMatch[2].replace(/^\s/, ''), tags, codeBlocks, texBlocks)
      out.push(`<h${lvl} class="md-h md-h${lvl}">${txt}</h${lvl}>`)
      continue
    }

    // 表格行
    if (/^\|.*\|$/.test(line)) {
      flushPara()
      const cells = line.slice(1, -1).split('|').map(c => c.trim())
      if (cells.every(c => /^[\s\-:]*$/.test(c))) continue
      if (!inTable) { out.push('<table class="md-table"><tbody>'); inTable = true }
      out.push('<tr>' + cells.map(c => `<td>${parseInline(c, tags, codeBlocks, texBlocks)}</td>`).join('') + '</tr>')
      continue
    } else if (inTable) {
      out.push('</tbody></table>')
      inTable = false
    }

    // 引用
    if (/^>\s?/.test(line)) {
      flushPara()
      out.push(`<blockquote class="md-blockquote">${parseInline(line.replace(/^>\s?/, ''), tags, codeBlocks, texBlocks)}</blockquote>`)
      continue
    }

    // 有序列表
    const olMatch = line.match(/^(\d+)\.\s(.+)/)
    if (olMatch) {
      flushPara()
      out.push(`<div class="md-li md-li-ol"><span class="md-li-num">${olMatch[1]}.</span> <span>${parseInline(olMatch[2], tags, codeBlocks, texBlocks)}</span></div>`)
      continue
    }

    // 任务列表
    if (/^-\s+\[x\]\s/i.test(line)) {
      flushPara()
      out.push(`<div class="md-li md-li-task"><span class="md-task md-task-done">☑</span> <span>${parseInline(line.replace(/^-\s+\[x\]\s*/i, ''), tags, codeBlocks, texBlocks)}</span></div>`)
      continue
    }
    if (/^-\s+\[\s\]\s/i.test(line)) {
      flushPara()
      out.push(`<div class="md-li md-li-task"><span class="md-task">☐</span> <span>${parseInline(line.replace(/^-\s+\[\s\]\s*/i, ''), tags, codeBlocks, texBlocks)}</span></div>`)
      continue
    }

    // 无序列表
    const ulMatch = line.match(/^(\s*)-(\s)(.+)/)
    if (ulMatch) {
      flushPara()
      const pad = ulMatch[1].length * 12
      out.push(`<div class="md-li md-li-ul" style="padding-left:${pad}px"><span class="md-bullet">•</span> <span>${parseInline(ulMatch[3], tags, codeBlocks, texBlocks)}</span></div>`)
      continue
    }

    // 普通文本：累加到段落缓冲
    paraBuf.push(parseInline(line, tags, codeBlocks, texBlocks))
  }

  flushPara()
  if (inTable) out.push('</tbody></table>')

  // Step 8: 还原所有占位符
  let html = out.join('')
  html = html.replace(/\x00ICODE(\d+)\x00/g, (_, idx) => inlineCodes[+idx])
  html = html.replace(/\x00IMG(\d+)\x00/g, (_, idx) => imgs[+idx])
  html = html.replace(/\x00MQQ(\d+)\x00/g, (_, idx) => mqqs[+idx])
  html = html.replace(/\x00LINK(\d+)\x00/g, (_, idx) => links[+idx])
  html = html.replace(/\x00TEXBLOCK(\d+)\x00/g, (_, idx) => {
    return `<div class="md-tex-block">${escHtml(texBlocks[+idx])}</div>`
  })
  html = html.replace(/\x00CODE(\d+)\x00/g, (_, idx) => {
    const cb = codeBlocks[+idx]
    return `<pre class="md-code-block"><code${cb.lang ? ` class="lang-${escHtml(cb.lang)}"` : ''}>${cb.code}</code></pre>`
  })
  html = html.replace(/\x00INLINE(\d+)\x00/g, (_, idx) => {
    const t = tags[+idx]
    return renderInlineMediaTag(t.tagType, t.tagBody, attachments, inlineTracker)
  })
  html = html.replace(/\x00AT(\d+)\x00/g, (_, idx) => atMentions[+idx])

  return html
}

// 解析行内元素
function parseInline(text, tags, codeBlocks, texBlocks) {
  if (!text) return ''

  const phs = []

  text = text.replace(/```(\w+)?\r?\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = phs.length
    phs.push(
        `<pre class="md-code-block"><code class="language-${escHtml(lang || '')}">${escHtml(code)}</code></pre>`
    )
    return `\x00PH${idx}\x00`
  })

  // 1. 提取行内代码 → 灰色背景 span
  text = text.replace(/`([^`\r\n]+)`/g, (_, code) => {
    const idx = phs.length
    phs.push(`<span class="md-inline-code">${escHtml(code)}</span>`)
    return `\x00PH${idx}\x00`
  })

  // 2. 提取行内 LaTeX $...$
  text = text.replace(/\$([^$\n]+)\$/g, (_, tex) => {
    const idx = phs.length
    phs.push(`<span class="md-tex-inline">${escHtml(tex)}</span>`)
    return `\x00PH${idx}\x00`
  })

  // 3. 提取 ![图片](url) — 必须在 []() 之前！] 和 ( 之间有 \s* 容忍空格
  text = text.replace(/!\s*\[([\s\S]*?)\]\s*\(([^)]+)\)/g, (_, alt, url) => {
    const idx = phs.length
    const cleanUrl = url.replace(/[\r\n]/g, '').replace(/\s+/g, '').trim()
    if (!cleanUrl) return _
    phs.push(renderMdImage(alt, cleanUrl))
    return `\x00PH${idx}\x00`
  })

  // 4. 提取 mqqapi 链接 [text](mqqapi://...)
  text = text.replace(/\[([^\]]*)\]\s*\((mqqapi:\/\/[^)]+)\)/g, (_, label, url) => {
    const idx = phs.length
    const cleanUrl = url.replace(/[\r\n]/g, '').replace(/\s+/g, '').trim()
    const cleanLabel = label.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
    phs.push(renderMqqapi(cleanLabel, cleanUrl))
    return `\x00PH${idx}\x00`
  })

  // 5. 提取 [text](url) 普通链接
  text = text.replace(/\[([^\]]+)\]\s*\((https?:\/\/[^)]+)\)/g, (_, label, url) => {
    const idx = phs.length
    const cleanUrl = url.replace(/[\r\n]/g, '').replace(/\s+/g, '').trim()
    const cleanLabel = label.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
    phs.push(`<a href="${escHtml(cleanUrl)}" target="_blank" class="md-link">${cleanLabel}</a>`)
    return `\x00PH${idx}\x00`
  })

  // 6. 提取 <url> 自动链接
  text = text.replace(/<(https?:\/\/[^>]+)>/g, (_, url) => {
    const idx = phs.length
    phs.push(`<a href="${escHtml(url)}" target="_blank" class="md-link">${escHtml(url)}</a>`)
    return `\x00PH${idx}\x00`
  })

  // 7. 转义剩余纯文本
  text = escHtml(text)

  // 8. 行内格式化 (在转义后的纯文本上)
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/__(.+?)__/g, '<u><strong>$1</strong></u>')
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
  text = text.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<em>$1</em>')
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>')

  // 9. 还原占位符
  text = text.replace(/\x00PH(\d+)\x00/g, (_, i) => phs[+i])

  return text
}

// 解析 mqqapi URL 参数
function parseMqqapiUrl(url) {
  // mqqapi://aio/inlinecmd?command=xxx&reply=false&enter=true
  const m = url.match(/^mqqapi:\/\/aio\/inlinecmd\?/)
  if (!m) return null
  const params = {}
  const qs = url.slice(m[0].length)
  qs.split('&').forEach(p => {
    const eq = p.indexOf('=')
    if (eq === -1) return
    params[decodeURIComponent(p.slice(0, eq))] = decodeURIComponent(p.slice(eq + 1))
  })
  return { type: 'inlinecmd', ...params }
}

// 渲染 mqqapi 链接为可点击按钮
function renderMqqapi(label, url) {
  const parsed = parseMqqapiUrl(url)
  if (parsed && parsed.type === 'inlinecmd') {
    const cmd = parsed.command || ''
    const reply = parsed.reply === 'true'
    const enter = parsed.enter === 'true'
    return `<span class="md-btn" data-cmd="${escHtml(cmd)}" data-reply="${reply}" data-enter="${enter}" onclick="handleMdBtnClick(this)">${label ? escHtml(label) : escHtml(cmd || '按钮')}</span>`
  }
  return `<code class="md-mqqapi" title="${escHtml(url)}">${label ? escHtml(label) : '🔗 mqqapi'}</code>`
}

// 渲染 Markdown 图片，支持 scheme 跳转和尺寸
function renderMdImage(alt, url) {
  let scheme = null
  let width = null, height = null
  let altText = alt || ''

  // 统一清理 alt 文本中的多余空白字符和换行
  altText = altText.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()

  // 反向转义 \" → "（QQ 原始数据中的转义引号）
  altText = altText.replace(/\\+"/g, '"')

  // 提取 scheme="..."（兼容 " 和 \" 写法）
  const scMatch = altText.match(/scheme\s*=\s*"([^"]*)"/)
  if (scMatch) {
    scheme = scMatch[1].trim()
    altText = altText.replace(scMatch[0], '')
  }

  // 提取尺寸 #Wpx #Hpx
  const szMatch = altText.match(/#?(\d+)px\s*#(\d+)px/)
  if (szMatch) {
    width = parseInt(szMatch[1])
    height = parseInt(szMatch[2])
    altText = altText.replace(szMatch[0], '')
  } else {
    const sMatch = altText.match(/#(\d+)px/)
    if (sMatch) {
      height = parseInt(sMatch[1])
      altText = altText.replace(sMatch[0], '')
    }
  }

  altText = altText.replace(/\s+/g, ' ').trim()

  // 清理 URL
  let cleanUrl = url.replace(/[?#]\d+px.*/, '').replace(/[#?]$/, '')

  // 从 URL 提取 scheme（如果不是从 alt 提取到的）
  if (!scheme) {
    const urlSc = cleanUrl.match(/[?&]scheme=([^&]+)/)
    if (urlSc) {
      scheme = decodeURIComponent(urlSc[1])
      cleanUrl = cleanUrl.replace(urlSc[0], '').replace(/[?&]$/, '')
    }
  }

  // 图片尺寸约束
  const MAX_W = 260
  if (width) {
    if (width > MAX_W && height) {
      height = Math.round(height * MAX_W / width)
      width = MAX_W
    }
  }

  const styles = []
  if (width) styles.push(`width:${width}px`)
  if (height) styles.push(`height:${height}px`)
  const styleStr = styles.length ? ` style="${styles.join(';')}"` : ''

  // 始终可点击：有 scheme → scheme 跳转，无 scheme → 图片原图链接
  const href = scheme || cleanUrl
  const imgHtml = `<img src="${escHtml(cleanUrl)}" alt="${escHtml(altText)}" class="md-img"${styleStr} loading="lazy">`
  return `<a href="${escHtml(href)}" target="_blank" class="md-img-link">${imgHtml}</a>`
}

// mqqapi 按钮点击处理
function handleMdBtnClick(el) {
  const cmd = el.dataset.cmd
  const reply = el.dataset.reply === 'true'
  const enter = el.dataset.enter === 'true'

  if (reply) {
    // 查找该按钮所在消息
    const msgItem = el.closest('.msg-item')
    if (msgItem) {
      const msgIdx = msgItem.dataset.msgIdx
      if (msgIdx) {
        state.replyTo = {
          msg_idx: msgIdx,
          text: cmd.slice(0, 50)
        }
        updateReplyPreview()
      }
    }
  }

  const editor = $("#chatInput")
  if (editor) {
    editor.textContent = cmd
    editor.focus()
    // 触发输入事件以更新状态
    editor.dispatchEvent(new Event('input', { bubbles: true }))
  }

  if (enter) {
    setTimeout(() => sendMessage(), 100)
  }
}

// KaTeX 渲染数学公式（按需动态加载）
let _katexLoading = false, _katexLoaded = false

function renderKatex(el) {
  // 只处理包含公式的元素
  const blocks = el.querySelectorAll('.md-tex-block')
  const inlines = el.querySelectorAll('.md-tex-inline')
  if (!blocks.length && !inlines.length) return

  if (!_katexLoaded) {
    if (typeof katex === 'undefined') {
      if (_katexLoading) return
      _katexLoading = true

      // 加载 KaTeX CSS
      const css = document.createElement('link')
      css.rel = 'stylesheet'
      css.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css'
      css.media = 'print'
      css.onload = () => { css.media = 'all' }
      document.head.appendChild(css)

      // 加载 KaTeX JS
      const script = document.createElement('script')
      script.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js'
      script.onload = () => {
        _katexLoaded = true
        _katexLoading = false
        // 加载完成后渲染页面上所有公式（不仅是第一批）
        renderKatexNow(document.querySelectorAll('.md-tex-block'))
        renderKatexNow(document.querySelectorAll('.md-tex-inline'), false)
      }
      document.head.appendChild(script)
      return
    }
    _katexLoaded = true
  }

  renderKatexNow(blocks)
  renderKatexNow(inlines, false)
}

function renderKatexNow(nodes, displayMode) {
  // KaTeX 宏：补充不支持的命令
  const katexOpts = {
    throwOnError: false,
    strict: false,
    displayMode: displayMode !== false,
    macros: {
      "\\dddot": "\\mathop{#1}\\limits^{...}",  // 三点导数近似
      "\\fcolorbox": "\\colorbox{#2}{\\textcolor{#1}{#3}}" // 带框盒子近似
    }
  }
  nodes.forEach(node => {
    try {
      katex.render(node.textContent.trim(), node, katexOpts)
    } catch (e) {}
  })
}

// highlight.js 动态加载 + 语法高亮
let _hljsLoaded = false, _hljsLoading = false

// 记录 bot 自己发送的消息类型（audit_id → "markdown"|"legacy"|"media"）
const _botSentMsgTypes = {}
// openid → 昵称 全局缓存（来自 incoming 消息的 raw_event.d.mentions / raw_message at.nickname / API 查询）
const _mentionNickCache = {}
// 待查询 openid 去重集合 & 防抖定时器 & 关联的群 ID
let _pendingNickQuery = new Set()
let _pendingNickGroupIds = new Set()
let _nickQueryTimer = null
async function _flushNicknameQuery() {
  const openids = [..._pendingNickQuery].filter(uid => !_mentionNickCache[uid])
  const groupIds = [..._pendingNickGroupIds]
  _pendingNickQuery.clear()
  _pendingNickGroupIds.clear()
  _nickQueryTimer = null
  if (!openids.length) return
  const selfId = state.currentBotId
  if (!selfId) return
  try {
    const body = { openids }
    if (groupIds.length) body.group_ids = groupIds
    const resp = await fetch(`${API_BASE}/bot/${selfId}/nicknames`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!resp.ok) return
    const data = await resp.json()
    const newlyResolved = []
    for (const [uid, nick] of Object.entries(data)) {
      if (nick) { _mentionNickCache[uid] = nick; newlyResolved.push(uid) }
    }
    if (!newlyResolved.length) return
    // 更新 DOM 中仍显示 openid 的 AT 胶囊
    const resolveSet = new Set(newlyResolved)
    document.querySelectorAll('.msg-at-capsule[data-at-uid]').forEach(el => {
      const uid = el.dataset.atUid
      if (!resolveSet.has(uid)) return
      const nick = _mentionNickCache[uid]
      if (!nick || el.dataset.atNick === nick) return
      el.dataset.atNick = nick
      el.title = `点击@${nick}`
      el.textContent = `@${nick}`
    })
  } catch (e) {}
}
function _scheduleNicknameQuery(openids, groupId) {
  for (const uid of openids) _pendingNickQuery.add(uid)
  if (groupId) _pendingNickGroupIds.add(groupId)
  if (!_nickQueryTimer) {
    _nickQueryTimer = setTimeout(_flushNicknameQuery, 50)
  }
}
function highlightCode(el) {
  const blocks = el.querySelectorAll ? el.querySelectorAll('.md-code-block code') : []
  if (!blocks.length) return

  if (!_hljsLoaded) {
    if (typeof hljs === 'undefined') {
      if (_hljsLoading) return
      _hljsLoading = true

      const css = document.createElement('link')
      css.rel = 'stylesheet'
      css.href = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github.min.css'
      document.head.appendChild(css)

      const script = document.createElement('script')
      script.src = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js'
      script.onload = () => {
        _hljsLoaded = true; _hljsLoading = false
        applyHighlight(document.querySelectorAll('.md-code-block code'))
      }
      document.head.appendChild(script)
      return
    }
    _hljsLoaded = true
  }

  applyHighlight(blocks)
}

function applyHighlight(codeEls) {
  codeEls.forEach(el => {
    try {
      const cls = el.className.match(/lang-(\S+)/)
      let lang = cls ? cls[1] : ''
      // 若语言未找到或未指定，默认使用 javascript
      if (!lang || !hljs.getLanguage(lang)) lang = 'javascript'
      el.classList.add(`language-${lang}`)
      hljs.highlightElement(el)
    } catch (e) {
      // 高亮失败不阻塞渲染
    }
  })
}

// 渲染内联媒体标签
function renderInlineMediaTag(tagType, tagBody, attachments, inlineTracker) {
  if (tagType === 'faceType') return ''
  if (tagType === 'attachmentType' && attachments) {
    const idxMatch = tagBody.match(/attachmentIndex=(\d+)/)
    if (idxMatch) {
      const idx = parseInt(idxMatch[1])
      const att = attachments[idx]
      if (att) {
        inlineTracker.add(idx)
        const mime = att.content_type || ''
        const url = escHtml(att.url || '')
        if (mime.startsWith('image/')) return `<img src="${url}" class="msg-inline-media" onclick="window.open(this.src)">`
        if (mime.startsWith('video/')) return `<video src="${url}" controls class="msg-inline-media"></video>`
        if (mime.startsWith('audio/') || mime.startsWith('voice/') || mime === 'voice') return `<audio src="${url}" controls></audio>`
        return `<a href="${url}" download="${escHtml(att.filename || '下载文件')}" class="msg-file-link">${escHtml(att.filename || '下载文件')}</a>`
      }
    }
  }
  return ''
}

// 共享函数：渲染消息内容（Segments + Attachments），返回 { messageContent, attachmentHtml, badges }
function renderMessageContent(m) {
  let messageContent = ""
  const inlineTracker = new Set()
  const isBot = m.me || m.is_bot

  // 对于 bot 自己发送的消息（m.me），仅在 markdown 类型时解析 markdown
  // 对于其他 bot 发送的消息（m.is_bot），总是解析 markdown
  const mdType = m.audit_id ? _botSentMsgTypes[m.audit_id] : null
  const shouldParseMd = m.me ? (mdType === "markdown") : isBot
  if (mdType && m.audit_id) delete _botSentMsgTypes[m.audit_id]

  // 附件列表（兼容 raw_event.d.attachments 和直接 .attachments 字段）
  const attachments = m.raw_event?.d?.attachments || m.attachments
  const attList = Array.isArray(attachments) ? attachments : []

  // 审核 + 回调标记
  let auditBadge = ""
  if (m.need_audit) {
    if (m.audit_status === "passed") {
      auditBadge = `<span class="msg-audit-badge audit-passed">审核通过</span>`
    } else if (m.audit_status === "rejected") {
      auditBadge = `<span class="msg-audit-badge audit-rejected">审核拒绝</span>`
    } else {
      auditBadge = `<span class="msg-audit-badge audit-pending">审核中</span>`
    }
  }
  const callbackBadge = m.is_callback ? `<span class="msg-callback-badge">回调消息</span>` : ""
  const badges = auditBadge + callbackBadge

  // 解析 message 字段
  let msgSegments = m.message
  if (Array.isArray(msgSegments) && msgSegments.length > 0 && Array.isArray(msgSegments[0])) {
    msgSegments = msgSegments.flat()
  }

  // 合并连续的 text 分段（同时将 at 内联到 text 中以避免 <p> 块级断裂）
  if (shouldParseMd && Array.isArray(msgSegments)) {
    // 先从 message 的 at segment 中补充昵称缓存，确保内联后的 <@openid> 能正确显示昵称
    for (const seg of msgSegments) {
      if (seg.type === "at" && seg.scope !== "all") {
        const pureUid = (seg.qq || "").includes(":") ? seg.qq.split(":").pop() : (seg.qq || seg.user_id || "")
        const nick = seg.nickname || seg.name || seg.username || ""
        if (pureUid && nick && !_mentionNickCache[pureUid]) {
          _mentionNickCache[pureUid] = nick
        }
      }
    }
    const merged = []
    for (const seg of msgSegments) {
      if (seg.type === "text" && merged.length > 0 && merged[merged.length - 1].type === "text") {
        merged[merged.length - 1] = { ...merged[merged.length - 1], text: (merged[merged.length - 1].text || "") + (seg.text || "") }
      } else if (seg.type === "at" && seg.scope !== "all") {
        // 将 at segment 内联到前一个 text segment 中（用 <@openid> 格式），
        // 避免 parseQqbotMarkdown 对每个 text segment 产生独立的 <p> 块
        const atUid = (seg.qq || "").includes(":") ? seg.qq.split(":").pop() : (seg.qq || seg.user_id || "")
        const atText = `<@${atUid}>`
        if (merged.length > 0 && merged[merged.length - 1].type === "text") {
          merged[merged.length - 1] = { ...merged[merged.length - 1], text: (merged[merged.length - 1].text || "") + atText }
        } else {
          merged.push({ type: "text", text: atText })
        }
      } else {
        merged.push({ ...seg })
      }
    }
    msgSegments = merged
  }

  // 统一提取媒体 URL（支持 _local 缓存路径 / QQ CDN URL / Buffer 等格式）
  const getMediaUrl = (field, seg) => {
    if (!field) return null
    if (typeof field === "string") {
      // _local 标记：通过 local-media 端点加载插件 data/ 下的本地缓存文件
      if (seg && seg._local) {
        return `${API_BASE}/bot/${state.currentBotId || ""}/local-media?path=${encodeURIComponent(field)}`
      }
      return field
    }
    if (field.type === "Buffer" && Array.isArray(field.data)) {
      const bytes = new Uint8Array(field.data)
      return URL.createObjectURL(new Blob([bytes]))
    }
    return null
  }
  // 收集来自 segment 的媒体项（video/audio/file），不在气泡内渲染
  const segMedia = []
  // 从 raw_event.d.mentions 填充全局昵称缓存
  if (m.raw_event?.d?.mentions && Array.isArray(m.raw_event.d.mentions)) {
    for (const mi of m.raw_event.d.mentions) {
      if (mi.username) {
        const key = mi.member_openid || mi.id || ""
        if (key) _mentionNickCache[key] = mi.username
        if (mi.id && mi.id !== key) _mentionNickCache[mi.id] = mi.username
      }
    }
  }
  // 也从 raw_message 的 at segment 尝试补全缓存（nickname 优先于 name）
  let rawMsg = Array.isArray(m.raw_message) ? m.raw_message : (Array.isArray(m.raw_message?.[0]) ? m.raw_message[0] : [])
  if (Array.isArray(rawMsg) && rawMsg.length > 0 && Array.isArray(rawMsg[0])) rawMsg = rawMsg.flat()
  for (const seg of rawMsg) {
    if (typeof seg === "string") continue // 字符串段由下方扫描处理
    if (seg.type === "at") {
      const pureUid = (seg.qq || "").includes(":") ? seg.qq.split(":").pop() : seg.qq
      if (!pureUid) continue
      // 优先用 nickname 字段（后端 sendGroupMessage 补全的），其次 name
      const nick = seg.nickname || seg.name || ""
      if (nick) {
        _mentionNickCache[pureUid] = nick
      }
    }
  }
  // 收集未缓存的 openid，异步查询 API 补全
  const uncachedOpenids = []
  const addUncached = (uid) => {
    if (uid && typeof uid === "string" && !_mentionNickCache[uid]) uncachedOpenids.push(uid)
  }
  const collectUncached = (text) => {
    if (!text || typeof text !== "string") return
    const re = /<@([A-Fa-f0-9]+)>/g
    let m2
    while ((m2 = re.exec(text)) !== null) {
      addUncached(m2[1])
    }
  }
  // 预扫描 message 和 raw_message 中所有 openid（文本中的 <@openid> + at segment）
  let msgSegs = Array.isArray(m.message) ? m.message : (Array.isArray(m.message?.[0]) ? m.message[0] : [])
  // 展平嵌套数组（与 msgSegments 一致），避免把字符串当对象遍历
  if (Array.isArray(msgSegs) && msgSegs.length > 0 && Array.isArray(msgSegs[0])) {
    msgSegs = msgSegs.flat()
  }
  for (const seg of msgSegs) {
    // 兼容 string 类型的段：直接按 text 段处理
    if (typeof seg === "string") {
      collectUncached(seg)
      continue
    }
    if (seg.type === "at" && seg.scope !== "all") {
      const pureUid = (seg.qq || seg.user_id || "").includes(":") ? (seg.qq || seg.user_id || "").split(":").pop() : (seg.qq || seg.user_id || "")
      addUncached(pureUid)
    } else if (seg.type === "markdown") collectUncached(seg.data?.content || seg.content)
    else if (seg.type === "text") collectUncached(seg.text)
  }
  for (const seg of rawMsg) {
    if (typeof seg === "string") { collectUncached(seg); continue }
    if (seg.type === "at" && seg.scope !== "all") {
      const pureUid = (seg.qq || seg.user_id || "").includes(":") ? (seg.qq || seg.user_id || "").split(":").pop() : (seg.qq || seg.user_id || "")
      addUncached(pureUid)
    } else if (seg.type === "text") collectUncached(seg.text)
  }

  if (uncachedOpenids.length) _scheduleNicknameQuery(uncachedOpenids, m.group_id)

  // 将 <@openid> 替换为 @昵称 胶囊的辅助函数（优先从缓存取，回退到截断的 openid）
  const atCapsuleHtml = (uid) => {
    const nick = _mentionNickCache[uid] || uid
    // 二次保障：渲染阶段发现仍未缓存，主动发起 API 查询（可能扫描阶段遗漏了某些段类型）
    if (!_mentionNickCache[uid] && uid && m.group_id) {
      _scheduleNicknameQuery([uid], m.group_id)
    }
    // 无昵称时截断开 openid 显示，避免长 openid 撑爆气泡
    const show = nick === uid ? (uid.length > 12 ? uid.slice(0, 12) + '…' : uid) : nick
    const titleUid = escHtml(uid)
    const titleNick = escHtml(nick)
    const displayNick = escHtml(show)
    return `<span class="msg-at-capsule" data-at-uid="${titleUid}" data-at-nick="${titleNick}" title="@${titleUid}">@${displayNick}</span>`
  }
  const replaceAtInText = (text) => {
    if (!text || typeof text !== 'string') return text
    return text.replace(/<@([A-Fa-f0-9]+)>/g, (match, uid) => atCapsuleHtml(uid))
  }

  if (Array.isArray(msgSegments)) {
    messageContent = msgSegments.map(seg => {

      if (seg.type === "text") {
        const text = seg.text || ""
        // text 类型：非 markdown 模式需要 replaceAtInText；markdown 模式由 parseQqbotMarkdown 内部处理
        const processed = shouldParseMd ? text : replaceAtInText(text)
        return shouldParseMd ? parseQqbotMarkdown(processed, attList, inlineTracker) : renderTextWithInlineMedia(processed, attList, inlineTracker)
      }
      if (seg.type === "markdown") {
        let content = seg.data?.content || seg.content || ""
        // 先将 <@openid> 替换为占位符保护，避免 parseQqbotMarkdown 内部的 escHtml 破坏生成的胶囊 HTML
        const atCapsules = []
        content = content.replace(/<@([A-Fa-f0-9]+)>/g, (match, uid) => {
          const capsule = atCapsuleHtml(uid)
          const idx = atCapsules.length
          atCapsules.push(capsule)
          return `\x00ATC${idx}\x00`
        })
        let html = parseQqbotMarkdown(content, attList, inlineTracker)
        // 还原 AT 胶囊
        html = html.replace(/\x00ATC(\d+)\x00/g, (_, idx) => atCapsules[+idx])
        return html
      }
      if (seg.type === "image") {
        const url = getMediaUrl(seg.file, seg) || getMediaUrl(seg.data, seg) || seg.url || ""
        if (!url) return ""
        return `<img src="${escHtml(url)}" class="msg-inline-media" onclick="window.open(this.src)" />`
      }
      // video → 收集到 segMedia，不在气泡内渲染
      if (seg.type === "video") {
        const videoUrl = getMediaUrl(seg.file, seg) || getMediaUrl(seg.data, seg) || seg.url || ""
        if (videoUrl) {
          segMedia.push({ content_type: "video/mp4", url: videoUrl, filename: seg.name || "", width: seg.width, height: seg.height })
        }
        return ""
      }
      // audio / record / voice → 优先使用 wav 转码链接
      if (seg.type === "audio" || seg.type === "record" || seg.type === "voice") {
        const wavUrl = seg.voice_wav_url || ""
        const directUrl = seg.url || ""
        const bufUrl = getMediaUrl(seg.file, seg) || getMediaUrl(seg.data, seg)
        const audioUrl = wavUrl || directUrl || bufUrl
        if (audioUrl) {
          segMedia.push({ content_type: "audio/amr", url: audioUrl, filename: seg.name || "", voice_wav_url: wavUrl || audioUrl, asr_refer_text: seg.asr_refer_text || "" })
        }
        return ""
      }
      // file → 收集到 segMedia
      if (seg.type === "file") {
        const fileUrl = getMediaUrl(seg.file, seg) || getMediaUrl(seg.data, seg) || seg.url || ""
        if (fileUrl) {
          segMedia.push({ content_type: "application/octet-stream", url: fileUrl, filename: seg.name || "下载文件", size: seg.size || seg.file_size || seg.fileSize || seg.byte_size || seg.byteSize || seg.filesize || seg.file_info?.size || (seg.req && seg.req.QFile && seg.req.QFile.filesize) || 0 })
        }
        return ""
      }
      if (seg.type === "at") {
        const rawUid = seg.qq || ""
        // 统一用纯 openid 作为缓存 key 和 data-at-uid，确保异步查询后能精准更新 DOM
        const pureUid = rawUid.includes(":") ? rawUid.split(":").pop() : rawUid
        // 优先从 segment 取昵称，其次从全局缓存取，回退到截断的 openid
        let atNick = seg.nickname || seg.name || ""
        if (!atNick && pureUid && _mentionNickCache[pureUid]) atNick = _mentionNickCache[pureUid]
        const show = atNick || (pureUid.length > 12 ? pureUid.slice(0, 12) + '…' : pureUid)
        const titleNick = atNick || pureUid
        return `<span class="msg-at-capsule" data-at-uid="${escHtml(pureUid)}" data-at-nick="${escHtml(titleNick)}" title="点击@${escHtml(titleNick)}">@${escHtml(show)}</span>`
      }
      if (seg.type === "reply") return ""
      if (seg.type === "face") return ""
      // 兼容原始字符串段（展平嵌套数组后可能出现）
      if (typeof seg === "string") {
        const processed = shouldParseMd ? seg : replaceAtInText(seg)
        return renderTextWithInlineMedia(processed, attList, inlineTracker)
      }
      return ""
    }).join("").trim()
    // 文本 segment 仅产出了内联媒体（attachmentType 标签），无实际文字 → 清空内容，交由附件区渲染
    if (attList.length > 0 && messageContent) {
      const textContent = messageContent.replace(/<[^>]*>/g, '').replace(/\s+/g, '').trim()
      if (!textContent) {
        messageContent = ''
        inlineTracker.clear() // 清空内联索引，让附件区统一渲染这些附件
      }
    }
  } else if (typeof m.message === "string") {
    messageContent = shouldParseMd
      ? parseQqbotMarkdown(m.message, attList, inlineTracker).trim()
      : renderTextWithInlineMedia(m.message, attList, inlineTracker).trim()
    // content 仅包含 attachmentType 标签时，清空内联内容（附件区统一渲染）
    // 更稳健的检测：移除所有 HTML 标签和空白后无实际文本内容
    if (attList.length > 0 && messageContent) {
      const textContent = messageContent.replace(/<[^>]*>/g, '').replace(/\s+/g, '').trim()
      if (!textContent) {
        messageContent = ''
        inlineTracker.clear() // 清空内联索引，让附件区统一渲染这些附件
      }
    }
  } else {
    const raw = m.raw_message || ""
    messageContent = shouldParseMd
      ? parseQqbotMarkdown(raw, attList, inlineTracker).trim()
      : renderTextWithInlineMedia(raw, attList, inlineTracker).trim()
    messageContent = messageContent || escHtml(JSON.stringify(m.message) || "")
  }

  // 安全网：清理 messageContent 中所有可能残留的 <faceType=...> 和 <attachmentType=...> 标签
  if (messageContent) {
    messageContent = messageContent.replace(/<(faceType|attachmentType)=[^>]*>/g, '')
  }

  // 附件：合并 segment 媒体 + 未内联渲染的 attachments
  let attachmentHtml = ""
  const segHasImages = Array.isArray(msgSegments) && msgSegments.some(s => {
    if (s.type !== "image") return false
    const url = getMediaUrl(s.file, s) || getMediaUrl(s.data, s) || s.url || ""
    return !!url
  })
  const remaining = attList.filter((_, i) => {
    if (inlineTracker.has(i)) return false
    // 段中已有有效渲染的图片，且内容非空（图片已内联） → 排除附件中重复的图片
    // 若 messageContent 为空（纯图片已被清空），则释放附件图片
    if (messageContent && segHasImages && (attList[i].content_type || "").startsWith("image/")) return false
    return true
  })
  // 去重：若 remaining 已覆盖某类型媒体，segMedia 同类型不重复渲染
  const coveredTypes = new Set()
  for (const r of remaining) {
    const mt = r.content_type || ""
    if (mt.startsWith("video/")) coveredTypes.add("video")
    else if (mt.startsWith("audio/") || mt.startsWith("voice/") || mt === "voice") coveredTypes.add("audio")
    else if (!mt.startsWith("image/")) coveredTypes.add("file")
  }
  const segMediaFiltered = segMedia.filter(s => {
    const ct = s.content_type || ""
    if (ct.startsWith("video/") && coveredTypes.has("video")) return false
    if (ct.startsWith("audio/") && coveredTypes.has("audio")) return false
    if (coveredTypes.has("file") && !ct.startsWith("video/") && !ct.startsWith("audio/")) return false
    return true
  })
  // 浅拷贝 remaining 中的 attachment 对象，避免 localUrlMap 替换 url 时
  // 直接修改 m.raw_event.d.attachments 原对象（remaining 引用了同一批对象）
  const allMedia = [...segMediaFiltered, ...remaining.map(item => ({ ...item }))]
  // 对于已缓存在本地的媒体，将附件的 CDN URL 替换为 local-media 端点 URL
  //   避免点击图片时跳转到原始 CDN 链接
  {
    const localUrlMap = {}
    const flatSegs = Array.isArray(msgSegments[0]) && msgSegments.length > 0 ? msgSegments.flat() : msgSegments
    for (const s of (Array.isArray(flatSegs) ? flatSegs : [])) {
      if (s._local && s.url && s.file) {
        const localUrl = getMediaUrl(s.file, s)
        if (localUrl) localUrlMap[s.url] = localUrl
      }
    }
    for (const item of allMedia) {
      if (item.url && localUrlMap[item.url]) {
        item.url = localUrlMap[item.url]
      }
    }
  }
  if (allMedia.length > 0) {
    const isSelf = m.me
    attachmentHtml = '<div class="msg-attachments">' +
      allMedia.map(item => {
        const itemMime = item.content_type || ""
        // 视频卡片传入 badges（显示在播放按钮上方）
        const itemBadges = itemMime.startsWith("video/") ? badges : ""
        return renderAttachment(item, isSelf, itemBadges)
      }).join("") +
      '</div>'
  }

  // 引用消息摘要（ref_summary 由后端批量填充）
  const refSummary = m.ref_summary || null

  return { messageContent, attachmentHtml, badges, refSummary }
}

function getNoticeText(m) {
  const nick = escHtml(m.nickname || "未知")
  const botNick = m.bot_nickname ? escHtml(m.bot_nickname) : ""
  switch (m.sub_type) {
    case "increase":
      return `@${nick} 加入了群聊`
    case "decrease":
      return `@${nick} 退群了`
    case "add":
      return `@${nick} 邀请 ${botNick || "机器人"} 加入了群聊`
    case "del":
      return `@${nick} 将 ${botNick || "机器人"} 移出了群聊`
    default:
      return `@${nick}`
  }
}

// 从消息中提取第一张图片的可用 URL（用于「添加表情」）
// 解析 segment 中的媒体字段为可用 URL（与 renderMessageContent 内部的 getMediaUrl 逻辑一致）
function resolveMediaUrl(field, seg) {
  if (!field) return null
  if (typeof field === "string") {
    if (seg && seg._local) {
      return `${API_BASE}/bot/${state.currentBotId || ""}/local-media?path=${encodeURIComponent(field)}`
    }
    return field
  }
  if (field.type === "Buffer" && Array.isArray(field.data)) {
    const bytes = new Uint8Array(field.data)
    return URL.createObjectURL(new Blob([bytes]))
  }
  return null
}

function getMessageImageUrl(m) {
  if (!m) return ""
  // 从 segment 取 image 类型（兜底：右键未直接命中图片元素时使用）
  const segs = Array.isArray(m.message) ? m.message : (Array.isArray(m.message?.[0]) ? m.message[0] : [])
  const flat = Array.isArray(segs) && segs.length && Array.isArray(segs[0]) ? segs.flat() : segs
  if (Array.isArray(flat)) {
    for (const seg of flat) {
      if (seg && seg.type === "image") {
        const url = resolveMediaUrl(seg.file, seg) || resolveMediaUrl(seg.data, seg) || seg.url || ""
        if (url) return url
      }
    }
  }
  return ""
}

function renderMessages(messages, position = "beforeend") {
  const container = $("#chatMessages")

  const fragment = document.createDocumentFragment()

  for (const m of messages) {
    // 通知事件：以灰色胶囊样式显示在聊天记录中间
    if (m.is_notice) {
      const div = document.createElement("div")
      div.className = "msg-item msg-notice"
      div.dataset.timestamp = m.timestamp || ""
      div.dataset.userId = m.user_id || ""
      div.dataset.eventId = m.event_id || ""
      const avatarSrc = m.avatar || ""
      const noticeText = getNoticeText(m)
      const time = formatTime(m.timestamp)
      div.innerHTML = `
        <div class="msg-notice-pill">
          <span class="msg-notice-time">${time}</span>
          <div class="msg-notice-body">
            <img class="msg-notice-avatar" src="${avatarSrc}" alt="" onerror="this.style.display='none'">
            <span class="msg-notice-text">${noticeText}</span>
          </div>
        </div>
      `
      div.addEventListener("contextmenu", (e) => {
        e.preventDefault()
        showContextMenu(e, m)
      })
      addLongPress(div, (e) => showContextMenu(e, m))
      fragment.appendChild(div)
      continue
    }

    const isSelf = m.me
    const isBot = m.me || m.is_bot

    const div = document.createElement("div")
    div.className = `msg-item ${isSelf ? "msg-self" : ""} ${!isSelf && m.is_bot ? "is-bot" : ""}`
    div.dataset.msgIdx = m.msg_idx || ""
    div.dataset.messageId = m.message_id || ""
    div.dataset.auditId = m.audit_id || ""
    div.dataset.eventId = m.event_id || ""
    div.dataset.needAudit = m.need_audit ? "true" : "false"
    div.dataset.timestamp = m.timestamp || ""
    div.dataset.userId = m.user_id || ""

    const avatarSrc = m.avatar || ""
    const nickname = escHtml(m.nickname || m.user_id || "未知")
    const time = formatTime(m.timestamp)
    const roleBadge = getRoleBadgeHtml(m.sender?.role)
    const botMark = isBot ? ' <span style="font-size:10px;color:var(--success)">[Bot]</span>' : ""
    // 拉黑用户标记
    const blUserBadge = (!isSelf && !m.is_notice && checkUserBlacklisted(extractOpenidFromMessage(m), m.unionid || ""))
      ? '<span class="blacklist-badge">拉黑</span>' : ""

    // 转发消息（聊天记录）特殊处理：渲染折叠卡片
    if (isForwardMessage(m)) {
      fragment.appendChild(buildForwardCard(m))
      continue
    }

    // 撤回状态
    const recalled = m.recalled
    if (recalled) div.classList.add("msg-recalled")

    const { messageContent, attachmentHtml, badges, refSummary } = renderMessageContent(m)
    const hasText = !!messageContent

    // 引用条（消息含有引用时显示，类似 QQ 的引用效果）
    let refBarHtml = ""
    if (!recalled && refSummary) {
      const isFallback = refSummary.source === "fallback"
      const refNick = escHtml(refSummary.nickname || "未知")
      const refText = escHtml((refSummary.summary || "").slice(0, 50))
      const refClass = isFallback ? "msg-ref-bar msg-ref-bar-fallback" : "msg-ref-bar"
      const onClick = isFallback ? "" : `onclick="scrollToRefMsg(this)"`
      const title = isFallback ? "无法定位到原始消息（从事件中提取的引用内容）" : "点击跳转到被引用消息"
      // 降级引用中渲染附件缩略图
      let thumbHtml = ""
      if (isFallback && Array.isArray(refSummary.fallback_attachments) && refSummary.fallback_attachments.length) {
        for (const att of refSummary.fallback_attachments) {
          if (att.url) {
            thumbHtml += `<img class="msg-ref-thumb" src="${escHtml(att.url)}" alt="" onerror="this.style.display='none'">`
          }
        }
      }
      refBarHtml = `<div class="${refClass}" data-ref-idx="${escHtml(refSummary.msg_idx || m.ref_msg_idx || "")}" ${onClick} title="${title}">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" style="flex-shrink:0;margin-right:4px;"><path d="M2 7l3-4M2 7l3 4M2 7h10"/></svg>
        <span class="msg-ref-nick">${refNick}</span>
        <span class="msg-ref-text">${refText}</span>
        ${thumbHtml}
      </div>`
    }

    // 有文本时才显示气泡，引用条放在气泡内部（像QQ一样）
    const bubbleRowHtml = recalled
      ? ""
      : hasText
        ? `<div class="msg-bubble-row">
             <div class="msg-bubble">${refBarHtml}${messageContent}</div>
             ${badges}
           </div>`
        : (refBarHtml
            ? `<div class="msg-bubble-row">
                 <div class="msg-bubble" style="padding:6px 10px;">${refBarHtml}</div>
               </div>`
            : "")

    // 无文本时把 badges 放到附件左侧下方（水平行：badges 在左，附件在右，底部对齐）
    // 视频卡片已有自己的 badges，避免重复
    let finalAttachmentHtml = attachmentHtml
    if (!hasText && badges && !attachmentHtml.includes("msg-video-badges-outside")) {
      if (isSelf && attachmentHtml) {
        finalAttachmentHtml = `<div class="msg-attach-row"><div class="msg-attach-badges">${badges}</div>${attachmentHtml}</div>`
      } else if (!isSelf && attachmentHtml) {
        finalAttachmentHtml = attachmentHtml + `<div class="msg-attach-badges">${badges}</div>`
      } else {
        finalAttachmentHtml = `<div class="msg-attach-badges">${badges}</div>`
      }
    }

    div.innerHTML = `
      <img class="msg-avatar" ${avatarSrc ? `data-lazy-src="${escHtml(avatarSrc)}"` : ""} alt="" onerror="this.style.display='none'">
      <div class="msg-body">
        <div class="msg-sender">${blUserBadge}${nickname}${roleBadge} <span class="msg-time-inline">${time}</span>${botMark}</div>
        ${bubbleRowHtml}
        ${finalAttachmentHtml}
        ${recalled ? `<div class="msg-recalled-tip">已撤回</div>` : ""}
        ${m.msg_idx ? `<div class="msg-idx">idx: ${m.msg_idx}</div>` : ""}
      </div>
    `

    renderKatex(div)
    highlightCode(div)
    div.addEventListener("contextmenu", (e) => {
      e.preventDefault()
      showContextMenu(e, m)
    })

    // 移动端长按 → 右键菜单
    addLongPress(div, (e) => showContextMenu(e, m))

    // 点击头像 → 用户信息弹窗
    const avatarImg = div.querySelector(".msg-avatar")
    if (avatarImg) {
      avatarImg.addEventListener("click", (e) => {
        e.stopPropagation()
        showUserInfoModal(m, "chat")
      })
    }

    fragment.appendChild(div)
  }

  if (position === "afterbegin") {
    container.insertBefore(fragment, container.firstChild)
  } else {
    container.appendChild(fragment)
  }

  // 懒加载消息头像
  observeLazyAvatars(container)
}

// 重新渲染当前所有消息（用于拉黑/取消拉黑后即时更新标记）
function reRenderCurrentMessages() {
  if (!state.messages || state.messages.length === 0) return
  const container = $("#chatMessages")
  // 移除所有消息条目，保留加载指示器
  container.querySelectorAll(".msg-item").forEach(el => el.remove())
  renderMessages(state.messages, "beforeend")
}

function formatTime(ts) {
  if (!ts) return ""
  // 兼容秒级(10位)和毫秒级(13位)时间戳
  ts = ts < 1000000000000 ? ts * 1000 : ts
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// 判断用户当前是否在消息底部（容差 60px，因为屏幕底部到真实底部的距离）
function isAtBottom() {
  const container = $("#chatMessages")
  if (!container) return true
  // scrollHeight - scrollTop - clientHeight 表示距离底部的像素
  // 容差 60px 内都认为"在底部"
  return container.scrollHeight - container.scrollTop - container.clientHeight < 60
}

// 更新浮动小球组整体显隐
function updateFloatGroup() {
  const group = $("#scrollFloatGroup")
  const unreadBadge = $("#unreadBadge")
  const arrowBadge = $("#scrollArrowBadge")
  if (!group) return

  const showUnread = state.unreadCount > 0
  const showArrow = !isAtBottom()

  // 更新未读计数小球
  if (unreadBadge) {
    if (showUnread) {
      unreadBadge.textContent = state.unreadCount > 99 ? "99+" : state.unreadCount
      unreadBadge.style.display = "flex"
    } else {
      unreadBadge.style.display = "none"
      state.firstUnreadEl = null
    }
  }

  // 更新向下箭头小球
  if (arrowBadge) {
    arrowBadge.style.display = showArrow ? "flex" : "none"
  }

  // 容器显隐
  group.style.display = (showUnread || showArrow) ? "flex" : "none"
}

// 只在容器内滚动，不影响页面布局（替代 scrollIntoView）
function scrollMsgIntoView(container, el, block = "center") {
  const cRect = container.getBoundingClientRect()
  const tRect = el.getBoundingClientRect()
  let top
  if (block === "start") {
    top = container.scrollTop + tRect.top - cRect.top
  } else if (block === "end") {
    top = container.scrollTop + tRect.bottom - cRect.bottom
  } else {
    top = container.scrollTop + tRect.top - cRect.top - (cRect.height - tRect.height) / 2
  }
  container.scrollTo({ top: Math.max(0, top), behavior: "smooth" })
}

// 点击引用条，跳转到被引用消息
async function scrollToRefMsg(el) {
  const refIdx = el.dataset.refIdx
  if (!refIdx) return

  const container = $("#chatMessages")

  // 先在当前 DOM 中查找
  let targetEl = container.querySelector(`.msg-item[data-msg-idx="${CSS.escape(refIdx)}"]`)
  if (targetEl) {
    scrollMsgIntoView(container, targetEl, "center")
    // 高亮闪烁效果
    targetEl.style.transition = "background-color 0.3s"
    targetEl.style.backgroundColor = "rgba(79,110,247,0.15)"
    setTimeout(() => { targetEl.style.backgroundColor = "" }, 1500)
    return
  }

  // 当前未加载：向上加载更多历史消息，直到找到该消息
  if (!state.hasMore) {
    alert("被引用的消息不在历史记录中")
    return
  }

  state.isLoadingMore = true
  const oldScrollHeight = container.scrollHeight

  let found = false
  let attempts = 0
  const maxAttempts = 20

  while (!found && state.hasMore && attempts < maxAttempts) {
    attempts++
    try {
      const chatId = state.chatType === "group" ? state.currentGroupId : state.currentPrivateUserId
      const prefix = state.chatType === "group" ? "group" : "private"
      let url = `/bot/${state.currentBotId}/${prefix}/${chatId}/messages?limit=50`
      if (state.oldestTimestamp) {
        url += `&before=${encodeURIComponent(JSON.stringify({ timestamp: state.oldestTimestamp, msg_idx: state.oldestMsgIdx }))}`
      }
      const newMessages = await api(url)
      if (!Array.isArray(newMessages) || newMessages.length === 0) {
        state.hasMore = false
        break
      }

      // 检查是否包含目标消息
      for (const m of newMessages) {
        if (m.msg_idx === refIdx) {
          found = true
          break
        }
      }

      // 追加到 DOM
      renderMessages(newMessages, "afterbegin")

      // 更新游标
      const oldest = newMessages[0]
      state.oldestTimestamp = oldest.timestamp
      state.oldestMsgIdx = oldest.msg_idx || null

      if (found) break
    } catch (err) {
      console.error("[scrollToRefMsg] 加载历史消息失败:", err)
      break
    }
  }

  if (!found) {
    state.isLoadingMore = false
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight - oldScrollHeight
    })
    alert("被引用的消息未找到")
    return
  }

  // 等待渲染完成
  await new Promise(r => requestAnimationFrame(r))
  await new Promise(r => requestAnimationFrame(r))

  // 恢复滚动位置
  container.scrollTop = container.scrollHeight - oldScrollHeight

  // 查找并滚动到目标
  targetEl = container.querySelector(`.msg-item[data-msg-idx="${CSS.escape(refIdx)}"]`)
  if (targetEl) {
    scrollMsgIntoView(container, targetEl, "center")
    // 高亮闪烁效果
    targetEl.style.transition = "background-color 0.3s"
    targetEl.style.backgroundColor = "rgba(79,110,247,0.15)"
    setTimeout(() => { targetEl.style.backgroundColor = "" }, 1500)
  }

  state.isLoadingMore = false
}

function scrollToBottom() {
  const container = $("#chatMessages")
  const doScroll = () => { container.scrollTop = container.scrollHeight }

  // Phase 1: immediate + RAF
  doScroll()
  requestAnimationFrame(doScroll)

  // Phase 2: listen for image load events and poll until stable
  requestAnimationFrame(() => {
    let prevHeight = container.scrollHeight
    let stable = 0
    let frames = 0

    const tick = () => {
      doScroll()
      const h = container.scrollHeight
      if (h === prevHeight) {
        stable++
        if (stable >= 20 && frames >= 30) return // ~500ms of stability + minimum 500ms
      } else {
        stable = 0
      }
      prevHeight = h
      frames++
      if (frames < 60) requestAnimationFrame(tick) // max ~1s
    }

    // Attach load listeners only for images still loading
    let loadExpected = 0
    container.querySelectorAll("img.msg-inline-media, video.msg-inline-media").forEach(media => {
      if (media.tagName === "IMG" && !media.complete) {
        loadExpected++
        media.addEventListener("load", () => {
          loadExpected--
          // Image loaded → restart polling from scratch
          stable = 0
        }, { once: true })
      }
      if (media.tagName === "VIDEO" && media.readyState < 2) {
        loadExpected++
        media.addEventListener("loadedmetadata", () => {
          loadExpected--
          stable = 0
        }, { once: true })
      }
    })

    // If images are already loaded but layout may still be settling
    if (loadExpected === 0) stable = 0

    requestAnimationFrame(tick)
  })
}

// ===== 上下文菜单 =====
let contextMessage = null
let contextImageUrl = "" // 右键/长按命中的图片 URL（多图消息时取具体那张）

function showContextMenu(e, message) {
  contextMessage = message
  const menu = $("#contextMenu")
  const isNotice = !!message.is_notice

  // 通知类消息与非通知消息的菜单项适配
  const noticeOnly = new Set(['raw', 'rawevent', 'reply_eventid', 'userInfo', 'delete'])
  const noticeHide = new Set(['copy', 'copymsg', 'reply', 'reply_msgid', 'echo', 'echo_md', 'at', 'recall', 'mute', 'unmute'])

  for (const item of menu.querySelectorAll('.context-menu-item')) {
    const action = item.dataset.action
    if (!action) continue
    if (isNotice) {
      item.style.display = noticeOnly.has(action) ? "" : "none"
    } else {
      // 非通知消息：恢复默认规则
      if (action === 'recall') {
        // 撤回：群聊中的非回调消息均可撤回（包括其他用户的消息）
        item.style.display = (state.chatType === "group" && !message.is_callback) ? "" : "none"
      } else if (action === 'rawevent') {
        item.style.display = message.me ? "none" : ""
      } else if (action === 'reply_eventid') {
        item.style.display = message.event_id ? "" : "none"
      } else if (action === 'delete') {
        item.style.display = ""
      } else {
        item.style.display = ""
      }
    }
  }

  // 用户黑名单菜单项：非自己、非通知
  if (!isNotice && !message.me) {
    const openid = extractOpenidFromMessage(message)
    if (openid) {
      const isBl = checkUserBlacklisted(openid, message.unionid)
      const blDivider = menu.querySelector('[data-divider="bl"]')
      if (blDivider) blDivider.style.display = ""
      $("#ctxBlUser").style.display = isBl ? "none" : ""
      $("#ctxUnblUser").style.display = isBl ? "" : "none"
    }
  } else {
    const blDivider = menu.querySelector('[data-divider="bl"]')
    if (blDivider) blDivider.style.display = "none"
    $("#ctxBlUser").style.display = "none"
    $("#ctxUnblUser").style.display = "none"
  }

  // 禁言/取消禁言菜单项：仅群聊、非Bot、非自己、普通成员(member)、非通知
  const muteDivider = menu.querySelector('[data-divider="mute"]')
  const muteItem = menu.querySelector('[data-action="mute"]')
  const unmuteItem = menu.querySelector('[data-action="unmute"]')
  if (!isNotice && !message.me && !message.is_bot && state.chatType === "group") {
    const role = message.sender?.role
    const userId = message.user_id || message.sender?.user_id
    if (role === "member" && userId) {
      muteDivider.style.display = ""
      const muted = isUserMuted(state.currentGroupId, userId)
      muteItem.style.display = muted ? "none" : ""
      unmuteItem.style.display = muted ? "" : "none"
    } else {
      muteDivider.style.display = "none"
      muteItem.style.display = "none"
      unmuteItem.style.display = "none"
    }
  } else {
    muteDivider.style.display = "none"
    muteItem.style.display = "none"
    unmuteItem.style.display = "none"
  }

  // 添加表情菜单项：仅当消息含图片（且非通知）时显示
  const emojiDivider = menu.querySelector('[data-divider="emoji"]')
  const emojiItem = menu.querySelector('[data-action="add-emoji"]')
  // 优先取右键/长按直接命中的图片元素 src，回退到消息 segment 扫描
  let imgUrl = ""
  if (!isNotice) {
    const t = e?.target
    if (t && (t.tagName === "IMG" || t.tagName === "VIDEO") && t.src) imgUrl = t.src
    if (!imgUrl) imgUrl = getMessageImageUrl(message)
  }
  if (!isNotice && imgUrl) {
    contextImageUrl = imgUrl
    if (emojiDivider) emojiDivider.style.display = ""
    if (emojiItem) emojiItem.style.display = ""
  } else {
    contextImageUrl = ""
    if (emojiDivider) emojiDivider.style.display = "none"
    if (emojiItem) emojiItem.style.display = "none"
  }

  menu.style.display = "block"
  // 先放到视野外获取真实尺寸
  menu.style.left = "-9999px"
  menu.style.top = "-9999px"
  const menuW = menu.scrollWidth
  const menuH = menu.scrollHeight

  const pad = 8
  let left = e.clientX
  let top = e.clientY

  // 右侧溢出 → 向左偏移
  if (left + menuW > window.innerWidth - pad) {
    left = window.innerWidth - menuW - pad
  }
  // 底部溢出 → 向上偏移
  if (top + menuH > window.innerHeight - pad) {
    top = window.innerHeight - menuH - pad
  }

  menu.style.left = `${Math.max(pad, left)}px`
  menu.style.top = `${Math.max(pad, top)}px`
}

function hideContextMenu() {
  $("#contextMenu").style.display = "none"
  contextMessage = null
}

// ===== 群右键菜单 =====
let groupContextGroupId = null

function showGroupContextMenu(e, groupId) {
  groupContextGroupId = groupId
  const group = state.groups.find(g => g.group_id === groupId)
  const isBlacklisted = group?.is_blacklisted
  const isBound = !!state.groupBindings[groupId]
  $("#ctxBlGroup").style.display = isBlacklisted ? "none" : ""
  $("#ctxUnblGroup").style.display = isBlacklisted ? "" : "none"
  $("#ctxBindGroup").style.display = isBound ? "none" : ""
  $("#ctxUnbindGroup").style.display = isBound ? "" : "none"
  $("#ctxRefreshGroupInfo").style.display = ""
  $("#ctxPinGroup").innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M9 2l3 3-1 1-1-1-2 2v5l-2 1 1-2 3-3-1-1 2-2z"/></svg>' + (isGroupPinned(groupId) ? "取消置顶" : "置顶")

  const menu = $("#groupContextMenu")
  menu.style.display = "block"
  // 先放到视野外获取真实尺寸
  menu.style.left = "-9999px"
  menu.style.top = "-9999px"
  const menuW = menu.scrollWidth
  const menuH = menu.scrollHeight

  const pad = 8
  let left = e.clientX
  let top = e.clientY

  if (left + menuW > window.innerWidth - pad) {
    left = window.innerWidth - menuW - pad
  }
  if (top + menuH > window.innerHeight - pad) {
    top = window.innerHeight - menuH - pad
  }

  menu.style.left = `${Math.max(pad, left)}px`
  menu.style.top = `${Math.max(pad, top)}px`
}

function hideGroupContextMenu() {
  $("#groupContextMenu").style.display = "none"
  groupContextGroupId = null
}

// ===== 私聊用户右键菜单 =====
let privateUserContextData = null

function showPrivateUserContextMenu(e, userId, openid, unionid) {
  privateUserContextData = { userId, openid, unionid }
  // 优先用服务端注入的 is_blacklisted
  const u = state.privateChats?.find(p => String(p.user_id) === String(userId))
  const isBlacklisted = u?.is_blacklisted || checkUserBlacklisted(openid, unionid)
  $("#ctxBlPvUser").style.display = isBlacklisted ? "none" : ""
  $("#ctxUnblPvUser").style.display = isBlacklisted ? "" : "none"
  $("#ctxPinPrivate").innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M9 2l3 3-1 1-1-1-2 2v5l-2 1 1-2 3-3-1-1 2-2z"/></svg>' + (isPrivatePinned(userId) ? "取消置顶" : "置顶")

  const menu = $("#privateUserContextMenu")
  menu.style.display = "block"
  menu.style.left = "-9999px"
  menu.style.top = "-9999px"
  const menuW = menu.scrollWidth
  const menuH = menu.scrollHeight

  const pad = 8
  let left = e.clientX
  let top = e.clientY

  if (left + menuW > window.innerWidth - pad) {
    left = window.innerWidth - menuW - pad
  }
  if (top + menuH > window.innerHeight - pad) {
    top = window.innerHeight - menuH - pad
  }

  menu.style.left = `${Math.max(pad, left)}px`
  menu.style.top = `${Math.max(pad, top)}px`
}

function hidePrivateUserContextMenu() {
  $("#privateUserContextMenu").style.display = "none"
  privateUserContextData = null
}

async function handlePrivateUserContextAction(action) {
  if (!privateUserContextData) return
  const { userId, openid, unionid } = privateUserContextData
  switch (action) {
    case "blacklist-pv-user": {
      if (!openid) { showToast("无法获取用户 OpenID"); break }
      if (!state.currentBotId) { showToast("未选择 Bot"); break }
      try {
        await api(`/bot/${state.currentBotId}/blacklist/user`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ openid, unionid }),
        })
        showToast("已拉黑用户")
        await loadBlacklistData()
        // 更新列表中的 is_blacklisted 标记
        const u = state.privateChats.find(u => String(u.user_id) === String(userId))
        if (u) u.is_blacklisted = true
        renderPrivateChatList()
        reRenderCurrentMessages()
      } catch (err) {
        console.error("拉黑用户失败:", err)
        showToast("拉黑失败: " + err.message)
      }
      break
    }
    case "unblacklist-pv-user": {
      if (!openid) { showToast("无法获取用户 OpenID"); break }
      if (!state.currentBotId) { showToast("未选择 Bot"); break }
      try {
        await api(`/bot/${state.currentBotId}/blacklist/user`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ openid, unionid }),
        })
        showToast("已取消拉黑用户")
        await loadBlacklistData()
        const u = state.privateChats.find(u => String(u.user_id) === String(userId))
        if (u) u.is_blacklisted = false
        renderPrivateChatList()
        reRenderCurrentMessages()
      } catch (err) {
        console.error("取消拉黑用户失败:", err)
        showToast("取消拉黑失败: " + err.message)
      }
      break
    }
    case "pin-private":
      togglePinPrivate(userId)
      renderPrivateChatList()
      showToast(isPrivatePinned(userId) ? "已置顶该用户" : "已取消置顶该用户")
      break
  }
}

// ===== 黑名单辅助函数 =====
function extractOpenidFromMessage(msg) {
  // 优先直接取 openid 字段
  if (msg.openid) return msg.openid
  // 从 user_id 提取 (格式 "selfId:openid")
  if (msg.user_id && msg.user_id.includes(":")) {
    return msg.user_id.split(":").pop()
  }
  return ""
}

function checkUserBlacklisted(openid, unionid) {
  const bl = state.blacklist
  if (openid && bl.openid.includes(openid)) return true
  if (unionid && bl.unionid.includes(unionid)) return true
  return false
}

async function loadBlacklistData() {
  if (!state.currentBotId) {
    state.blacklist = { groups: [], userid: [], unionid: [] }
    return
  }
  try {
    const data = await api(`/bot/${state.currentBotId}/blacklist`)
    // 转为 client 侧兼容格式：userid 数组存纯 openid
    state.blacklist = {
      groups: (data.groups || []).map(g => g.group_id),
      openid: (data.users || []).map(u => u.openid),
      unionid: (data.users || []).map(u => u.unionid).filter(Boolean),
    }
  } catch (err) {
    console.error("[loadBlacklistData] 加载黑名单失败:", err)
    state.blacklist = { groups: [], openid: [], unionid: [] }
  }
}

async function loadMutedUsers() {
  if (!state.currentBotId || !state.currentGroupId) return
  try {
    const data = await api(`/bot/${state.currentBotId}/group/${state.currentGroupId}/muted`)
    state.mutedUsers[state.currentGroupId] = data.muted || {}
  } catch (err) {
    console.error("[loadMutedUsers] 加载禁言列表失败:", err)
  }
}

function isUserMuted(groupId, userId) {
  return !!(state.mutedUsers[groupId] && state.mutedUsers[groupId][String(userId)])
}

function handleGroupContextAction(action) {
  if (!groupContextGroupId) return
  switch (action) {
    case "note":
      showGroupNoteModal(groupContextGroupId)
      break
    case "bind-group":
      showBindGroupModal(groupContextGroupId)
      break
    case "unbind-group":
      unbindGroupQQ(groupContextGroupId)
      break
    case "refresh-group-info":
      refreshSingleGroupInfo(groupContextGroupId)
      break
    case "group-info":
      showGroupInfoModal(groupContextGroupId)
      break
    case "blacklist-group":
      blacklistGroupFromWeb(groupContextGroupId)
      break
    case "unblacklist-group":
      unblacklistGroupFromWeb(groupContextGroupId)
      break
    case "pin-group":
      togglePinGroup(groupContextGroupId)
      if (state.groupMode !== "quanliang") {
        ensureAllGroups().then(() => renderGroupList())
      }
      renderGroupList()
      showToast(isGroupPinned(groupContextGroupId) ? "已置顶该群聊" : "已取消置顶该群聊")
      break
  }
}

async function blacklistGroupFromWeb(groupId) {
  try {
    await api(`/bot/${state.currentBotId}/blacklist/group`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: groupId }),
    })
    showToast("已拉黑群聊")
    // 即时更新本地 state，避免等待服务器刷新
    await loadBlacklistData()
    const g = state.groups.find(g => g.group_id === groupId)
    if (g) g.is_blacklisted = true
    renderGroupList()
    reRenderCurrentMessages()
  } catch (err) {
    console.error("拉黑群聊失败:", err)
    showToast("拉黑失败: " + err.message)
  }
}

async function unblacklistGroupFromWeb(groupId) {
  try {
    await api(`/bot/${state.currentBotId}/blacklist/group`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: groupId }),
    })
    showToast("已取消拉黑群聊")
    await loadBlacklistData()
    const g = state.groups.find(g => g.group_id === groupId)
    if (g) g.is_blacklisted = false
    renderGroupList()
    reRenderCurrentMessages()
  } catch (err) {
    console.error("取消拉黑群聊失败:", err)
    showToast("取消拉黑失败: " + err.message)
  }
}

// ===== 群备注弹窗 =====
let noteModalGroupId = null
let currentGroupInfoId = null

function showGroupNoteModal(groupId) {
  noteModalGroupId = groupId
  const pureId = getPureGroupId(groupId)
  $("#noteModalGroupId").textContent = `群ID: ${pureId}`
  $("#noteModalInput").value = state.groupNotes[groupId] || ""
  $("#groupNoteModal").style.display = "flex"
  setTimeout(() => $("#noteModalInput").focus(), 100)
}

async function saveGroupNote() {
  const groupId = noteModalGroupId
  if (!groupId) return
  const note = $("#noteModalInput").value.trim()
  try {
    await api(`/bot/${state.currentBotId}/group/${groupId}/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    })
    if (!note) {
      delete state.groupNotes[groupId]
    } else {
      state.groupNotes[groupId] = note
    }
    renderGroupList()
    // 更新聊天头部
    if (state.currentGroupId === groupId) {
      const nameEl = $("#chatHeaderName")
      let displayName = note
      if (!displayName) {
        const qq = state.groupBindings[groupId]
        const boundInfo = qq ? state.boundGroupInfos[qq] : null
        displayName = boundInfo?.group_name || state.currentGroup?.group_name || getPureGroupId(groupId)
      }
      if (nameEl) nameEl.textContent = displayName
    }
  } catch (err) {
    console.error("保存群备注失败:", err)
    alert("保存失败: " + err.message)
  }
  closeGroupNoteModal()
}

function closeGroupNoteModal() {
  $("#groupNoteModal").style.display = "none"
  noteModalGroupId = null
}

// ===== 绑定QQ群号 =====
let bindModalGroupId = null

function showBindGroupModal(groupId) {
  bindModalGroupId = groupId
  const pureId = getPureGroupId(groupId)
  $("#bindModalGroupId").textContent = `群ID: ${pureId}`
  $("#bindModalInput").value = ""
  $("#bindModalHint").textContent = ""
  $("#bindGroupModal").style.display = "flex"
  setTimeout(() => $("#bindModalInput").focus(), 100)
}

function closeBindGroupModal() {
  $("#bindGroupModal").style.display = "none"
  bindModalGroupId = null
}

async function saveBindGroupQQ() {
  if (!bindModalGroupId) return
  const groupQQ = $("#bindModalInput").value.trim()
  if (!/^\d{5,12}$/.test(groupQQ)) {
    $("#bindModalHint").textContent = "请输入正确的QQ群号（5-12位数字）"
    return
  }
  $("#bindModalHint").textContent = ""
  try {
    const res = await api("/group-bind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: bindModalGroupId, groupQQ }),
    })
    // 更新本地状态
    state.groupBindings[bindModalGroupId] = groupQQ
    closeBindGroupModal()
    showToast(`已绑定QQ群号：${groupQQ}`)
    // 重新加载群信息
    await loadBoundGroupInfos()
    renderGroupList()
  } catch (err) {
    $("#bindModalHint").textContent = err.message || "绑定失败"
    console.error("绑定群号失败:", err)
  }
}

// ===== 禁言弹窗 =====
let muteContextMessage = null

function showMuteDialog(message) {
  muteContextMessage = message
  const userName = message.sender?.memberName || message.sender?.nickname || message.sender?.user_id || message.user_id || "未知用户"
  $("#muteModalUserName").textContent = userName
  $("#muteModalInput").value = ""
  $("#muteModal").style.display = "flex"
}

function closeMuteDialog() {
  $("#muteModal").style.display = "none"
  muteContextMessage = null
}

async function confirmMute() {
  const input = $("#muteModalInput")
  const val = parseInt(input.value, 10)
  if (!Number.isInteger(val) || val <= 0) {
    input.focus()
    return
  }

  const msg = muteContextMessage
  if (!msg) return
  const uid = msg.user_id || msg.sender?.user_id
  const gid = state.currentGroupId
  const btn = $("#muteModalConfirm")
  btn.disabled = true
  try {
    const r = await api(`/bot/${state.currentBotId}/group/${gid}/mute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: uid, minutes: val }),
    })
    if (!r.ok) throw new Error(r.error || "禁言失败")
    showToast(`已禁言 ${val} 分钟`)
    // 更新缓存
    if (!state.mutedUsers[gid]) state.mutedUsers[gid] = {}
    state.mutedUsers[gid][String(uid)] = true
    closeMuteDialog()
  } catch (err) {
    showToast("禁言失败: " + err.message)
  } finally {
    btn.disabled = false
  }
}

async function unbindGroupQQ(groupId) {
  if (!groupId) return
  try {
    const res = await api("/group-bind", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId }),
    })
    // 更新本地状态
    const oldQQ = state.groupBindings[groupId]
    delete state.groupBindings[groupId]
    if (oldQQ) delete state.boundGroupInfos[oldQQ]
    showToast(`已取消绑定QQ群号：${oldQQ}`)
    renderGroupList()
  } catch (err) {
    showToast("取消绑定失败: " + (err.message || ""))
    console.error("取消绑定群号失败:", err)
  }
}

// 刷新单个绑定群信息
async function refreshSingleGroupInfo(groupId) {
  try {
    // 通过官方 getGroupInfo 接口（/bot/:selfId/group/:groupId/info）刷新，无需第三方机器人
    const info = await api(`/bot/${state.currentBotId}/group/${encodeURIComponent(groupId)}/info`)
    // 接口已将群名/信息写回 gl，直接刷新列表即可
    if (info?.group_name) {
      const g = state.groups.find(x => x.group_id === groupId)
      if (g) g.group_name = info.group_name
    }
    renderGroupList()
    showToast(`已刷新群信息：${info?.group_name || groupId}`)
  } catch (err) {
    if (err?.kicked) showToast("刷新失败：机器人非群成员")
    else if (err?.groupInvalid) showToast("刷新失败：该群状态异常（可能已解散/被封禁）")
    else showToast("刷新失败: " + (err.message || ""))
  }
}

async function handleContextAction(action) {
  if (!contextMessage) return

  switch (action) {
    case "copy": {
      // 提取消息纯文本
      let text = contextMessage.raw_message || ""
      if (!text && Array.isArray(contextMessage.message)) {
        text = contextMessage.message.map(s => s.text || (s.data?.content || s.content || "")).join("")
      }
      if (!text && typeof contextMessage.message === "string") {
        text = contextMessage.message
      }
      if (text) {
        const copyTextCtx = () => {
          const ta = document.createElement("textarea")
          ta.value = text
          ta.style.position = "fixed"
          ta.style.left = "-9999px"
          document.body.appendChild(ta)
          ta.select()
          document.execCommand("copy")
          document.body.removeChild(ta)
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).catch(() => copyTextCtx())
        } else {
          copyTextCtx()
        }
      }
      break
    }
    case "raw": {
      // rawMsg：展示消息存储数据，过滤 buffer/base64
      const msg = contextMessage
      const rawData = sanitizeMsgForDisplay(msg)
      const title = $("#rawModalTitle")
      if (title) title.textContent = "Raw Message"
      const body = $("#rawModalBody")
      try {
        body.textContent = JSON.stringify(rawData, null, 2)
      } catch {
        body.textContent = String(rawData)
      }
      if (isMobile()) history.pushState({ rawModal: true }, "", location.href)
      $("#rawModal").style.display = "flex"
      break
    }
    case "rawevent": {
      // rawEvent：仅用户消息，展示 QQ SDK 原始事件（与存储数据隔离，不做任何改动）
      const msg = contextMessage
      let rawData = msg.raw_event
      if (!rawData && msg.msg_idx) {
        try {
          const prefix = state.chatType === "group" ? "group" : "private"
          const chatId = state.chatType === "group" ? state.currentGroupId : state.currentPrivateUserId
          rawData = await api(`/bot/${state.currentBotId}/${prefix}/${chatId}/message/raw?msg_idx=${msg.msg_idx}`)
        } catch {}
      }
      if (!rawData) rawData = { _note: "该消息没有 raw_event 数据" }
      const title = $("#rawModalTitle")
      if (title) title.textContent = "Raw Event"
      const body = $("#rawModalBody")
      try {
        // 深拷贝后显示，绝对不碰原始对象
        body.textContent = JSON.stringify(JSON.parse(JSON.stringify(rawData)), null, 2)
      } catch {
        body.textContent = String(rawData || "无数据")
      }
      if (isMobile()) history.pushState({ rawModal: true }, "", location.href)
      $("#rawModal").style.display = "flex"
      break
    }
    case "reply": {
      const msgIdx = contextMessage.msg_idx
      if (!msgIdx) {
        alert("该消息没有 msg_idx，无法引用")
        break
      }
      state.replyTo = {
        msg_idx: msgIdx,
        text: contextMessage.raw_message ||
              (Array.isArray(contextMessage.message)
                ? contextMessage.message.map(s => s.text || (s.data?.content || s.content || "")).join("").slice(0, 50)
                : "") || "[引用消息]"
      }
      updateReplyPreview()
      $("#chatInput").focus()

      // 切换到消息记录页
      if (state.currentPage !== "messages") {
        navigateTo("messages")
      }
      break
    }
    case "reply_msgid": {
      const messageId = contextMessage.message_id
      if (!messageId) {
        alert("该消息没有 msg_id，无法用于回复")
        break
      }
      state.replyMsgId = {
        message_id: messageId,
        text: contextMessage.raw_message ||
              (Array.isArray(contextMessage.message)
                ? contextMessage.message.map(s => s.text || (s.data?.content || s.content || "")).join("").slice(0, 50)
                : "") || "[消息]"
      }
      state.replyEventId = null
      updateMsgIdReplyPreview()
      updateEventIdReplyPreview()
      $("#chatInput").focus()

      // 切换到消息记录页
      if (state.currentPage !== "messages") {
        navigateTo("messages")
      }
      break
    }
    case "reply_eventid": {
      const eventId = contextMessage.event_id
      if (!eventId) {
        alert("该消息没有 event_id，无法用于回复")
        break
      }
      state.replyEventId = {
        event_id: eventId,
        text: contextMessage.nickname || contextMessage.raw_message?.slice(0, 50) || "[消息]"
      }
      state.replyMsgId = null
      updateMsgIdReplyPreview()
      updateEventIdReplyPreview()
      $("#chatInput").focus()

      if (state.currentPage !== "messages") {
        navigateTo("messages")
      }
      break
    }
    case "at": {
      // user_id 格式可能是 "selfId:openid"，提取纯 openid 用于 @ 提及
      let rawId = contextMessage.user_id || contextMessage.openid || ""
      if (rawId.includes(":")) {
        rawId = rawId.split(":").pop()
      }
      const nick = contextMessage.nickname || rawId
      insertMention(rawId, nick)
      // 切换到消息记录页
      if (state.currentPage !== "messages") {
        navigateTo("messages")
      }
      break
    }
    case "userInfo": {
      showUserInfoModal(contextMessage)
      break
    }
    case "echo":
    case "echo_md": {
      const segments = segmentsForEcho(contextMessage)
      if (!segments.length) break
      const chatId = state.chatType === "group" ? state.currentGroupId : state.currentPrivateUserId
      if (!state.currentBotId || !chatId) break
      try {
        const prefix = state.chatType === "group" ? "group" : "private"
        const body = { segments }
      // 复读也支持 event_id / message_id 回复
      if (state.replyEventId) {
        body.reply_event_id = state.replyEventId.event_id
      } else if (state.replyMsgId) {
        body.reply_msg_id = state.replyMsgId.message_id
      } else if (state.useReplyMsgId && state.messages.length > 0) {
          // state.messages 升序排列（旧→新），从后往前找最近一条非自己发的消息
          let latestOther = null
          for (let i = state.messages.length - 1; i >= 0; i--) {
            const m = state.messages[i]
            if (!m.me && m.message_id) { latestOther = m; break }
          }
          if (latestOther) body.reply_msg_id = latestOther.message_id
        }
        await api(`/bot/${state.currentBotId}/${prefix}/${chatId}/send`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Msg-Type": action === "echo_md" ? "markdown" : "legacy",
          },
          body: JSON.stringify(body),
        })
      } catch (err) {
        console.error("复读失败:", err)
        alert("复读失败: " + err.message)
      }
      break
    }
    case "recall": {
      if (state.chatType !== "group") {
        alert("私聊暂不支持撤回")
        break
      }
      const messageId = contextMessage.message_id
      const auditId = contextMessage.audit_id
      if (!messageId && !auditId) {
        alert("该消息没有可用的 message_id 或 audit_id，无法撤回")
        break
      }
      try {
        const res = await api(`/bot/${state.currentBotId}/group/${state.currentGroupId}/recall`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message_id: messageId || undefined,
            audit_id: auditId || undefined,
          }),
        })
        if (res.success) {
          // 直接在 DOM 中标记为已撤回
          markRecalledInDom(messageId, auditId)
        } else {
          alert("撤回失败，请重试")
        }
      } catch (err) {
        console.error("撤回失败:", err)
        alert("撤回失败: " + err.message)
      }
      break
    }
    case "copymsg": {
      copyMsgToInput(contextMessage)
      break
    }
    case "delete": {
      if (!confirm("确定要从数据库中删除这条消息吗？该操作不可撤销。")) break
      const msg = contextMessage
      const msgIdx = msg.msg_idx
      const messageId = msg.message_id
      const auditId = msg.audit_id
      const eventId = msg.event_id
      if (!msgIdx && !messageId && !auditId && !eventId) { alert("该消息没有可用的标识，无法删除"); break }
      try {
        const prefix = state.chatType === "group" ? "group" : "private"
        const chatId = state.chatType === "group" ? state.currentGroupId : state.currentPrivateUserId
        const res = await api(`/bot/${state.currentBotId}/${prefix}/${chatId}/message/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msg_idx: msgIdx || null, message_id: messageId || null, audit_id: auditId || null, event_id: eventId || null }),
        })
        if (res.success) {
          const container = $("#chatMessages")
          // 匹配哪个 data- 属性就用哪个选择器移除 DOM
          let el = null
          if (msgIdx) el = container.querySelector(`.msg-item[data-msg-idx="${CSS.escape(msgIdx)}"]`)
          if (!el && messageId) el = container.querySelector(`.msg-item[data-message-id="${CSS.escape(messageId)}"]`)
          if (!el && auditId) el = container.querySelector(`.msg-item[data-audit-id="${CSS.escape(auditId)}"]`)
          if (!el && eventId) el = container.querySelector(`.msg-item[data-event-id="${CSS.escape(eventId)}"]`)
          if (el) el.remove()
        } else {
          alert("删除失败，消息可能已不存在")
        }
      } catch (err) {
        console.error("删除消息失败:", err)
        alert("删除失败: " + err.message)
      }
      break
    }
    case "blacklist-user": {
      const openid = extractOpenidFromMessage(contextMessage)
      const unionid = contextMessage.unionid || ""
      if (!openid) { showToast("无法获取用户 OpenID"); break }
      try {
        await api(`/bot/${state.currentBotId}/blacklist/user`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ openid, unionid }),
        })
        showToast("已拉黑用户")
        await loadBlacklistData()
        if (state.chatType === "group") await loadGroups()
        else await loadPrivateChats()
        // 重新渲染当前消息以显示拉黑标记
        reRenderCurrentMessages()
      } catch (err) {
        console.error("拉黑用户失败:", err)
        showToast("拉黑失败: " + err.message)
      }
      break
    }
    case "unblacklist-user": {
      const openid = extractOpenidFromMessage(contextMessage)
      const unionid = contextMessage.unionid || ""
      if (!openid) { showToast("无法获取用户 OpenID"); break }
      try {
        await api(`/bot/${state.currentBotId}/blacklist/user`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ openid, unionid }),
        })
        showToast("已取消拉黑用户")
        await loadBlacklistData()
        if (state.chatType === "group") await loadGroups()
        else await loadPrivateChats()
        // 重新渲染当前消息以去除拉黑标记
        reRenderCurrentMessages()
      } catch (err) {
        console.error("取消拉黑用户失败:", err)
        showToast("取消拉黑失败: " + err.message)
      }
      break
    }
    case "mute": {
      showMuteDialog(contextMessage)
      break
    }
    case "unmute": {
      if (!contextMessage) break
      const uid = contextMessage.user_id || contextMessage.sender?.user_id
      const gid = state.currentGroupId
      if (!uid || !gid) break
      try {
        const r = await api(`/bot/${state.currentBotId}/group/${gid}/unmute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: uid }),
        })
        if (!r.ok) throw new Error(r.error || "取消禁言失败")
        showToast("已取消禁言")
        // 更新缓存
        if (state.mutedUsers[gid]) delete state.mutedUsers[gid][String(uid)]
      } catch (err) {
        showToast("取消禁言失败: " + err.message)
      }
      break
    }
    case "add-emoji": {
      // 优先使用右键/长按直接命中的具体图片（多图消息时即所选那张），回退扫描消息 segment
      const url = contextImageUrl || getMessageImageUrl(contextMessage)
      if (url) openEmojiAddModal(url)
      else showToast("未找到可添加的的图片")
      break
    }
  }
}

// ===== 消息图片「添加表情」弹窗 =====
const emojiAddState = {
  imageUrl: "",
  selected: new Set(), // 已勾选要添加的列表 folder
  loading: false,
}

async function openEmojiAddModal(imageUrl) {
  emojiAddState.imageUrl = imageUrl || ""
  emojiAddState.selected = new Set()
  emojiAddState.loading = false
  const modal = $("#emojiAddModal")
  const preview = $("#emojiAddPreviewImg")
  if (preview) preview.src = emojiAddState.imageUrl
  modal.style.display = "flex"
  try {
    const data = await api("/emoji/lists")
    const lists = Array.isArray(data.lists) ? data.lists : []
    renderEmojiAddList(lists)
  } catch (e) {
    console.error("[emojiAdd] 列表加载失败:", e)
    showToast("表情列表加载失败")
  }
}

function closeEmojiAddModal() {
  $("#emojiAddModal").style.display = "none"
  emojiAddState.imageUrl = ""
  emojiAddState.selected = new Set()
}

function renderEmojiAddList(lists) {
  const wrap = $("#emojiAddList")
  if (!lists.length) {
    wrap.innerHTML = '<div class="emoji-add-empty">暂无表情列表，请先在表情包中新建</div>'
    return
  }
  wrap.innerHTML = lists.map(l => {
    const iconHtml = l.icon
      ? (l.icon.includes(".") ? `<img src="${emojiStaticUrl("icon", l.icon)}" alt="">` : l.icon)
      : `<span class="emoji-default-icon">📁</span>`
    return `
      <div class="emoji-add-item" data-folder="${escHtml(l.folder)}">
        <div class="emoji-add-item-icon">${iconHtml}</div>
        <div class="emoji-add-item-title">${escHtml(l.title)}</div>
        <button class="emoji-add-toggle" data-folder="${escHtml(l.folder)}">添加</button>
      </div>
    `
  }).join("")

  wrap.querySelectorAll(".emoji-add-item").forEach(el => {
    const folder = el.dataset.folder
    const btn = el.querySelector(".emoji-add-toggle")
    if (emojiAddState.selected.has(folder)) {
      el.classList.add("selected")
      btn.textContent = "取消"
      btn.classList.add("added")
    }
    btn.addEventListener("click", () => {
      if (emojiAddState.selected.has(folder)) {
        emojiAddState.selected.delete(folder)
        el.classList.remove("selected")
        btn.textContent = "添加"
        btn.classList.remove("added")
      } else {
        emojiAddState.selected.add(folder)
        el.classList.add("selected")
        btn.textContent = "取消"
        btn.classList.add("added")
      }
    })
  })
}

// 在浏览器侧获取图片 Blob：优先带凭据 fetch（同源/local-media 可过登录态），
// 跨域被 CORS 拦截时回退到 canvas 绘制（图片已在页面中渲染，同源或带 crossOrigin 时可绘制）
async function fetchImageBlob(url) {
  // 1) 同源/带登录态的图片：带 cookie 直接 fetch
  try {
    const resp = await fetch(url, { credentials: "include", mode: "cors" })
    if (resp.ok && (resp.headers.get("content-type") || "").startsWith("image/")) {
      return await resp.blob()
    }
  } catch { /* 跨域 CORS 拦截，走回退 */ }
  // 2) canvas 绘制回退（处理跨域图片）
  return await new Promise((resolve, reject) => {
    const img = new Image()
    // 跨域图片尝试以匿名模式加载，若服务器允许 CORS 则可绘制
    img.crossOrigin = "anonymous"
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas")
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        canvas.getContext("2d").drawImage(img, 0, 0)
        canvas.toBlob((blob) => {
          if (blob) resolve(blob)
          else reject(new Error("图片转换失败"))
        }, "image/png")
      } catch (e) {
        reject(e)
      }
    }
    img.onerror = () => reject(new Error("图片加载失败"))
    img.src = url
  })
}

function emojiExtFromUrl(url) {
  const m = /\.(png|jpe?g|gif|webp|bmp)(?:[?#]|$)/i.exec(url || "")
  return m ? m[1].toLowerCase().replace("jpg", "jpeg") : "png"
}

async function confirmEmojiAdd() {
  const folders = [...emojiAddState.selected]
  if (!folders.length) {
    showToast("请先选择要添加的列表")
    return
  }
  if (!emojiAddState.imageUrl) {
    showToast("图片地址缺失")
    return
  }
  emojiAddState.loading = true
  const confirmBtn = $("#emojiAddConfirm")
  if (confirmBtn) confirmBtn.disabled = true
  try {
    // 浏览器侧取得图片二进制（带登录态，避免服务端二次抓取被 401）
    const blob = await fetchImageBlob(emojiAddState.imageUrl)
    const ext = emojiExtFromUrl(emojiAddState.imageUrl)
    const file = new File([blob], `msg_image.${ext}`, { type: blob.type || `image/${ext}` })
    let okCount = 0
    for (const folder of folders) {
      try {
        const fd = new FormData()
        fd.append("files", file, file.name)
        const data = await api(`/emoji/lists/${encodeURIComponent(folder)}/emojis`, { method: "POST", body: fd })
        if ((data.added && data.added.length) || data.skipped) okCount++
      } catch (e) {
        console.error(`[emojiAdd] 添加到 ${folder} 失败:`, e)
      }
    }
    showToast(okCount > 0 ? `已添加到 ${okCount} 个表情列表` : "添加失败")
    closeEmojiAddModal()
  } catch (e) {
    showToast("图片获取失败: " + (e.message || e))
  } finally {
    emojiAddState.loading = false
    if (confirmBtn) confirmBtn.disabled = false
  }
}

// ===== 转发消息（聊天记录）解析与渲染 =====
function isForwardMessage(m) {
  const content = m.raw_event?.d?.content || (typeof m.raw_message === "string" ? m.raw_message : "")
  return typeof content === "string" && content.includes("聊天记录") && /===+\s*消息\s*\d+\s*===+/i.test(content)
}

// 将原始 [群聊的聊天记录]...\n=== 消息 N ===\n[消息内容]...\n[发送者]... 解析为结构化数组
// QQ 视频下载链接默认带 format=origin&orgfmt=t265（H.265），浏览器无法解码；
// 去掉这两个参数后服务端会返回可内联播放的 H.264 版本
function normalizeQQVideoUrl(url) {
  try {
    const u = new URL(url)
    u.searchParams.delete("format")
    u.searchParams.delete("orgfmt")
    return u.toString()
  } catch {
    return url
  }
}

// 解析单条子消息块（顶层 === 消息 N === 或嵌套 --- 第N条 --- 通用）
function parseSingleMessageBlock(block) {
  const senderM = block.match(/\[发送者\]\s*([^\n]*)/)
  const sender = senderM ? senderM[1].trim() : "未知"
  const attachments = []
  // 附件只扫描 [关联消息] 之前的部分，避免把子消息（嵌套转发）的附件误归到父消息
  const attScope = block.split(/\[关联消息\]/)[0]
  const attRe = /\[附件\d+\]\s*类型:(\S+)(?:\s*文件名:(\S+))?(?:\s*尺寸:(\S+))?(?:\s*大小:(\S+))?\s*URL:(\S+)/g
  let am
  while ((am = attRe.exec(attScope)) !== null) {
    const type = am[1]
    const filename = am[2] || ""
    const url = am[5] || ""
    if (!url) continue
    if (type === "图片") attachments.push({ content_type: "image/jpeg", url, filename })
    else if (type === "视频") attachments.push({ content_type: "video/mp4", url: normalizeQQVideoUrl(url), filename })
    else attachments.push({ content_type: "application/octet-stream", url, filename })
  }
  const cM = block.match(/\[消息内容\]\s*([\s\S]*?)(?=\n\s*\[发送者\]|\n\s*\[附件\d+\]|\n\s*\[消息类型\]|\n\s*\[关联消息\]|$)/)
  const text = cM ? cM[1].trim() : ""
  // 是否为嵌套的合并转发消息
  const isForward = /合并转发消息/.test(block) || /\[消息内容\]\s*\[群聊的聊天记录\]/.test(block)
  let nested = null
  if (isForward) {
    // 注意：不要吞掉 [关联消息] 之后的前导空白，否则首个子分隔符的缩进会被抹掉，
    // 导致各层级分隔符缩进不一致，无法据此区分嵌套深度
    const relM = block.match(/\[关联消息\]([\s\S]*)$/)
    const relText = relM ? relM[1] : ""
    if (relText.trim()) nested = parseNestedMessages(relText)
  }
  return { sender, text, attachments, isForward, nested }
}

// 解析 [关联消息] 下 --- 第N条 --- 分隔的子消息列表（支持任意深度嵌套）
// 关键：只按“最小缩进层级”的 --- 第N条 --- 分隔符切分；更深层级的分隔符属于子转发，
// 保留在块内由 parseSingleMessageBlock 递归处理，从而保持嵌套结构不被拍平
function parseNestedMessages(relText) {
  const sepRe = /^([ \t]*)---+\s*第\s*\d+\s*条\s*---+\s*$/gm
  let minIndent = Infinity
  let m
  const seps = []
  while ((m = sepRe.exec(relText)) !== null) {
    const indent = m[1].length
    seps.push({ index: m.index, indent, end: sepRe.lastIndex })
    if (indent < minIndent) minIndent = indent
  }
  if (seps.length === 0) return []
  const messages = []
  let start = 0
  for (const sep of seps) {
    if (sep.indent !== minIndent) continue
    const block = relText.slice(start, sep.index)
    if (block.trim()) messages.push(parseSingleMessageBlock(block))
    start = sep.end
  }
  const lastBlock = relText.slice(start)
  if (lastBlock.trim()) messages.push(parseSingleMessageBlock(lastBlock))
  return messages
}

function parseForwardMessages(content) {
  const blocks = content.split(/===+\s*消息\s*\d+\s*===+/i)
  const messages = []
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block || !block.trim()) continue
    messages.push(parseSingleMessageBlock(block))
  }
  return messages
}

// 渲染 QQ face 标签（<face... ext="base64">）：解码 ext 取文本，失败回退 [表情]
function renderForwardFaceTag(ext) {
  if (ext) {
    try {
      const b64 = ext.replace(/-/g, "+").replace(/_/g, "/")
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const json = JSON.parse(new TextDecoder().decode(bytes))
      if (json && json.text) return `<span class="fwd-face" title="${escHtml(json.text)}">${escHtml(json.text)}</span>`
      // 文本为空（图片表情/贴纸）→ 直接过滤掉，真实内容由附件图片呈现
      return ""
    } catch {}
  }
  return `<span class="fwd-face" title="表情">[表情]</span>`
}

// 渲染单条转发消息的内容（文本 + 表情 + 附件；嵌套转发则渲染可展开卡片）
function renderForwardContent(text, attachments, msg) {
  // 嵌套转发：渲染可点击展开的嵌套聊天记录卡片
  if (msg && msg.isForward && msg.nested && msg.nested.length) {
    return renderNestedForward(msg)
  }
  let html = ""
  if (text) {
    let t = text
    // 带 ext 的表情：解码后文本为空（图片表情/贴纸）则丢弃，否则渲染文本
    t = t.replace(/<face[^>]*ext="([^"]*)"[^>]*>/gi, (_, ext) => renderForwardFaceTag(ext || ""))
    // 其余无 ext 的残留 <face...> 标签直接丢弃
    t = t.replace(/<face[^>]*>/gi, "")
    t = t.trim()
    t = escHtml(t).replace(/\n/g, "<br>")
    if (t) html += `<div class="fwd-msg-text">${t}</div>`
  }
  for (const att of attachments) {
    html += renderAttachment(att, false, "")
  }
  return html
}

// 渲染一组转发子消息（供顶层弹窗与嵌套展开复用）
function renderForwardMessagesList(msgs) {
  return msgs.map(msg => {
    const firstChar = (msg.sender || "?").trim().charAt(0) || "?"
    const contentHtml = renderForwardContent(msg.text, msg.attachments, msg)
    return `<div class="fwd-msg">
      <div class="fwd-avatar">${escHtml(firstChar)}</div>
      <div class="fwd-msg-body">
        <div class="fwd-msg-sender">${escHtml(msg.sender)}</div>
        <div class="fwd-msg-content">${contentHtml}</div>
      </div>
    </div>`
  }).join("")
}

// 渲染嵌套转发卡片（可点击展开查看内部消息）
function renderNestedForward(msg) {
  const id = _fwdNestedId++
  _fwdNestedMap.set(id, msg.nested)
  const previewLines = buildForwardPreview(msg.nested)
  const previewHtml = previewLines.map(l => escHtml(l)).join("<br>")
  const count = msg.nested.length
  return `<div class="fwd-nested">
    <div class="fwd-nested-bubble" data-nested-id="${id}">
      <div class="fwd-title">聊天记录</div>
      <div class="fwd-preview">${previewHtml}</div>
      <div class="fwd-count">共 ${count} 条</div>
    </div>
  </div>`
}

// 折叠卡片预览：取前 1~2 条，超长截断；图片/表情包/嵌套转发显示为占位符
function buildForwardPreview(messages) {
  const lines = []
  for (const msg of messages.slice(0, 2)) {
    let preview
    if (msg.isForward) {
      // 嵌套转发：直接以 [聊天记录] 表示
      preview = "[聊天记录]"
    } else {
      // 先去掉 face 标签并清理空白，避免原始 <face...> 文本泄露
      const cleanText = msg.text.replace(/<face[^>]*>/gi, "").trim()
      if (cleanText) {
        preview = cleanText.replace(/\n/g, " ").slice(0, 44)
      } else {
        const hasFace = /<face[^>]*>/i.test(msg.text)
        const hasImage = msg.attachments.some(a => a.content_type.startsWith("image/"))
        const hasVideo = msg.attachments.some(a => a.content_type.startsWith("video/"))
        // 表情包（face 占位）优先于图片附件，因为贴纸也是以图片形式下发
        if (hasFace) preview = "[动画表情]"
        else if (hasImage) preview = "[图片]"
        else if (hasVideo) preview = "[视频]"
        else if (msg.attachments.length) preview = "[文件]"
        else preview = "[空]"
      }
    }
    lines.push(`${msg.sender}: ${preview}`)
  }
  return lines
}

// 构建消息列表中的转发折叠卡片（复用外层消息的发送者头像/昵称）
function buildForwardCard(m) {
  const content = m.raw_event?.d?.content || (typeof m.raw_message === "string" ? m.raw_message : "")
  const msgs = parseForwardMessages(content)
  const count = msgs.length
  const isSelf = m.me
  const isBot = m.me || m.is_bot
  const div = document.createElement("div")
  div.className = `msg-item ${isSelf ? "msg-self" : ""} ${!isSelf && m.is_bot ? "is-bot" : ""}`
  div.dataset.msgIdx = m.msg_idx || ""
  div.dataset.messageId = m.message_id || ""
  div.dataset.timestamp = m.timestamp || ""
  div.dataset.userId = m.user_id || ""
  const avatarSrc = m.avatar || ""
  const nickname = escHtml(m.nickname || m.user_id || "未知")
  const time = formatTime(m.timestamp)
  const roleBadge = getRoleBadgeHtml(m.sender?.role)
  const botMark = isBot ? ' <span style="font-size:10px;color:var(--success)">[Bot]</span>' : ""
  const blUserBadge = (!isSelf && !m.is_notice && checkUserBlacklisted(extractOpenidFromMessage(m), m.unionid || ""))
    ? '<span class="blacklist-badge">拉黑</span>' : ""
  const previewLines = buildForwardPreview(msgs)
  const previewHtml = previewLines.map(l => escHtml(l)).join("<br>")
  div.innerHTML = `
    <img class="msg-avatar" src="${avatarSrc}" alt="" onerror="this.style.display='none'">
    <div class="msg-body">
      <div class="msg-sender">${blUserBadge}${nickname}${roleBadge} <span class="msg-time-inline">${time}</span>${botMark}</div>
      <div class="msg-bubble-row">
        <div class="msg-bubble fwd-bubble">
          <div class="fwd-title">聊天记录</div>
          <div class="fwd-preview">${previewHtml}</div>
          <div class="fwd-count">共 ${count} 条</div>
        </div>
      </div>
    </div>
  `
  // 点击气泡 → 打开转发详情弹窗
  const bubble = div.querySelector(".fwd-bubble")
  if (bubble) {
    bubble.addEventListener("click", () => openForwardModal(msgs))
  }
  // 头像点击 → 用户信息弹窗
  const avatarImg = div.querySelector(".msg-avatar")
  if (avatarImg) {
    avatarImg.addEventListener("click", (e) => {
      e.stopPropagation()
      showUserInfoModal(m, "chat")
    })
  }
  // 右键菜单（与其他消息一致）
  div.addEventListener("contextmenu", (e) => {
    e.preventDefault()
    showContextMenu(e, m)
  })
  addLongPress(div, (e) => showContextMenu(e, m))
  return div
}

let _forwardMsgs = null
let _forwardStack = []
// 嵌套聊天记录映射：气泡 data-nested-id → 嵌套消息数组（id 全局自增，不复用）
const _fwdNestedMap = new Map()
let _fwdNestedId = 0
function openForwardModal(msgs) {
  const body = $("#forwardBody")
  if (!body) return
  // 由嵌套卡片点入时，将当前内容压栈以便返回上一层
  if (_forwardMsgs && _forwardMsgs !== msgs) {
    _forwardStack.push(_forwardMsgs)
  }
  _forwardMsgs = msgs
  body.innerHTML = renderForwardMessagesList(msgs)
  $("#forwardModal").style.display = "flex"
  // 移动端：推入历史状态以支持返回键/关闭按钮分层导航
  if (isMobile()) {
    history.pushState({ forward: true }, "", location.href)
    state.mobileChatActive = true
  }
}

function closeForwardModal() {
  if (_forwardStack.length > 0) {
    // 返回上一层（如由嵌套聊天记录点入），弹窗保持打开
    const prev = _forwardStack.pop()
    _forwardMsgs = prev
    const body = $("#forwardBody")
    if (body) body.innerHTML = renderForwardMessagesList(prev)
  } else {
    $("#forwardModal").style.display = "none"
    _forwardMsgs = null
    _forwardStack = []
    _fwdNestedMap.clear()
    _fwdNestedId = 0
  }
}

// ===== 用户信息弹窗 =====
// 存储弹窗内当前用户数据，供黑名单按钮使用
let userInfoCurrentData = null

function showUserInfoModal(msg, source = "chat") {
  if (!msg) return

  // 记录来源以便返回导航
  state.userInfoSource = source

  // 从 msg.unionid（Redis存储字段名）或 raw_event 中提取 union_openid
  const rawEvent = msg.raw_event || {}
  const unionOpenid = msg.unionid || rawEvent.d?.author?.union_openid || ""

  // 提取 openid
  const openid = msg.openid || ""

  // 提取 user_id（可能是 "selfId:openid" 格式）
  const userId = msg.user_id || ""

  // 头像
  const avatar = msg.avatar || ""

  // 昵称
  const nickname = msg.nickname || userId || "未知"

  // Bot 标识
  const isBot = msg.me || msg.is_bot
  $("#userInfoBotBadge").style.display = isBot ? "" : "none"

  // 填充头像
  const avatarEl = $("#userInfoAvatar")
  const fallbackEl = $("#userInfoAvatarFallback")
  if (avatar) {
    avatarEl.src = avatar
    avatarEl.style.display = ""
    avatarEl.onerror = () => {
      avatarEl.style.display = "none"
      fallbackEl.style.display = "flex"
      fallbackEl.textContent = nickname[0] || "?"
    }
    fallbackEl.style.display = "none"
  } else {
    avatarEl.style.display = "none"
    fallbackEl.style.display = "flex"
    fallbackEl.textContent = nickname[0] || "?"
  }

  // 昵称
  $("#userInfoNick").textContent = nickname

  // 各字段
  $("#userInfoUnionId").textContent = unionOpenid || "-"
  $("#userInfoOpenId").textContent = openid || "-"
  $("#userInfoUserId").textContent = userId || "-"
  $("#userInfoAvatarUrl").textContent = avatar || "-"

  // 头像跳转按钮：有链接才显示
  const jumpBtn = $("#userInfoJumpAvatar")
  if (jumpBtn) jumpBtn.style.display = avatar ? "" : "none"

  // 黑名单按钮：非 Bot 才显示
  userInfoCurrentData = null
  if (!isBot && openid) {
    const isBl = checkUserBlacklisted(openid, unionOpenid)
    userInfoCurrentData = { openid, unionid: unionOpenid, userId }
    $("#userInfoBlBtn").style.display = isBl ? "none" : ""
    $("#userInfoUnblBtn").style.display = isBl ? "" : "none"
    $("#userInfoActions").style.display = ""
  } else {
    $("#userInfoActions").style.display = "none"
  }

  // 移动端：推入历史状态以支持返回键导航
  if (isMobile()) {
    history.pushState({ userInfo: true, from: source }, "", location.href)
    state.mobileChatActive = true
  }

  // 显示弹窗
  $("#userInfoModal").style.display = "flex"
}

function closeUserInfoModal() {
  $("#userInfoModal").style.display = "none"
  state.userInfoSource = null
}

// ===== 群信息弹窗 =====
async function showGroupInfoModal(groupId) {
  const modal = $("#groupInfoModal")
  if (!modal) return
  currentGroupInfoId = groupId
  const pureId = getPureGroupId(groupId)
  // 先填充兜底 openid，避免空白
  $("#groupInfoOpenId").textContent = pureId
  // 拉黑按钮：根据当前拉黑状态初始化文案
  const blBtn = $("#groupInfoBlBtn")
  const isBl = !!(state.groups.find(g => g.group_id === groupId)?.is_blacklisted)
  if (blBtn) {
    blBtn.textContent = isBl ? "取消拉黑此群" : "拉黑此群"
    blBtn.classList.toggle("unbl", isBl)
  }
  $("#groupInfoName").textContent = "加载中…"
  $("#groupInfoTags").innerHTML = ""
  $("#groupInfoMemberNum").textContent = "-"
  $("#groupInfoNote").textContent = "-"
  $("#groupInfoFingerMemo").textContent = "-"
  $("#groupInfoClassText").textContent = "-"
  $("#groupInfoAvatarField").style.display = "none" // 有绑定群 qq 时才显示
  modal.style.display = "flex"
  try {
    const data = await api(`/bot/${state.currentBotId}/group/${encodeURIComponent(groupId)}/info`)
    // 群名 + 复制
    const name = data.group_name || pureId
    $("#groupInfoName").textContent = name
    // 头像：优先绑定真实头像（QQ 群），否则按 openid 首字母兜底
    const qq = state.groupBindings[groupId]
    const avatarEl = $("#groupInfoAvatar")
    const fallbackEl = $("#groupInfoAvatarFallback")
    if (qq) {
      avatarEl.src = `http://p.qlogo.cn/gh/${qq}/${qq}/640`
      avatarEl.style.display = "block"
      fallbackEl.style.display = "none"
      // 群头像链接字段：可复制 + 可跳转
      const avatarUrl = `http://p.qlogo.cn/gh/${qq}/${qq}/640`
      const avatarUrlEl = $("#groupInfoAvatarUrl")
      avatarUrlEl.textContent = avatarUrl
      avatarUrlEl.href = avatarUrl
      $("#groupInfoAvatarField").style.display = "block"
      // 跳转按钮：有链接才显示（与用户信息弹窗一致）
      const jumpBtn = $("#groupInfoJumpAvatar")
      if (jumpBtn) jumpBtn.style.display = ""
    } else {
      avatarEl.style.display = "none"
      fallbackEl.style.display = "flex"
      fallbackEl.textContent = (data.group_openid || pureId)[0] || "?"
    }
    // 群标签胶囊（淡蓝）
    const tagsEl = $("#groupInfoTags")
    const tags = Array.isArray(data.group_tags) ? data.group_tags : []
    tagsEl.innerHTML = tags.map(t => {
      const txt = typeof t === "string" ? t : (t?.text || t?.name || "")
      return txt ? `<span class="group-tag">${escHtml(String(txt))}</span>` : ""
    }).join("")
    // 群人数：记录人数（gl）/ 实际人数（接口）
    const recorded = data.recorded_member_num || 0
    const actual = data.group_member_num || 0
    $("#groupInfoMemberNum").textContent = `${recorded} / ${actual}`
    // openid
    $("#groupInfoOpenId").textContent = data.group_openid || pureId
    // 群备注（有的话显示，没有显示空）
    $("#groupInfoNote").textContent = data.note || "（未设置）"
    // 群指纹备注
    $("#groupInfoFingerMemo").textContent = data.group_finger_memo || "（无）"
    // 群分类
    $("#groupInfoClassText").textContent = data.group_class_text || "（无）"
  } catch (err) {
    $("#groupInfoName").textContent = pureId
    if (err?.kicked) {
      $("#groupInfoMemberNum").textContent = "机器人非群成员"
    } else {
      $("#groupInfoMemberNum").textContent = "加载失败"
    }
    console.error("群信息加载失败:", err)
  }
}

function closeGroupInfoModal() {
  const modal = $("#groupInfoModal")
  if (modal) modal.style.display = "none"
}

// 刷新群信息：重新调用 /group/:groupId/info（getGroupInfo）并填充弹窗
async function refreshGroupInfo(groupId) {
  if (!groupId) return
  const btn = $("#groupInfoRefreshBtn")
  if (btn) { btn.disabled = true; btn.textContent = "刷新中…" }
  try {
    await showGroupInfoModal(groupId)
    showToast("群信息已刷新")
  } catch (e) {
    console.error("刷新群信息失败:", e)
    showToast("刷新失败: " + (e.message || e))
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "刷新群信息" }
  }
}

// ===== rawMsg 展示：过滤 buffer/base64 数据，防止卡顿 =====

/** 过滤对象中的 buffer/base64 数据，替换为占位文本 */
function deepSanitizeBuffers(obj) {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === "string") {
    if (obj.length > 500 && /^[A-Za-z0-9+/=]{500,}$/.test(obj.slice(0, 500))) {
      return "[base64数据]"
    }
    return obj
  }
  if (typeof obj === "object" && obj.type === "Buffer" && Array.isArray(obj.data)) return "[buffer数据]"
  if (Array.isArray(obj)) return obj.map(deepSanitizeBuffers)
  if (typeof obj === "object") {
    const clean = {}
    for (const k of Object.keys(obj)) {
      clean[k] = deepSanitizeBuffers(obj[k])
    }
    return clean
  }
  return obj
}

/** Bot 消息专用：过滤 message 中的 buffer/base64 */
function sanitizeMsgForDisplay(msg) {
  const copy = { ...msg }
  if (copy.raw_event) copy.raw_event = deepSanitizeBuffers(copy.raw_event)
  if (copy.message) copy.message = deepSanitizeBuffers(copy.message)
  if (copy.raw_message) copy.raw_message = deepSanitizeBuffers(copy.raw_message)
  return copy
}

// ===== 复制消息到输入框 =====

/** 从 message segments 提取纯文本 */
function extractTextFromSegments(message) {
  if (!message) return ""
  const segs = Array.isArray(message[0]) && message.length > 0 ? message.flat() : (Array.isArray(message) ? message : [])
  return segs.map(s => {
    if (s.type === "text") return s.text || ""
    if (s.type === "image") return "[图片]"
    if (s.type === "at") return `@${s.qq || ""}`
    if (s.type === "reply") return "[引用]"
    return s.text || ""
  }).join("")
}

/** 将消息内容复制到输入框，自动处理 @mention、图片缩略图、引用 */
function copyMsgToInput(msg) {
  const editor = $("#chatInput")
  editor.focus()
  editor.innerHTML = ""

  const items = []  // { type, text?, qq?, nickname?, imageUrl?, fileName? }
  let refMsgIdx = null

  if (msg.me) {
    // Bot 自己的消息：直接从 message 提取，处理 reply 引用
    const msgs = msg.message
    const flat = Array.isArray(msgs[0]) && msgs.length > 0 ? msgs.flat() : (Array.isArray(msgs) ? msgs : [])
    for (const s of flat) {
      if (s.type === "reply" && s.id) {
        refMsgIdx = s.id
      } else if (s.type === "text" && s.text) {
        items.push({ type: "text", text: s.text })
      } else if (s.type === "image") {
        // Bot 消息的图片段：file 可能是 URL、base64、本地路径或 Buffer
        let imageUrl = null, originalUrl = null
        const fileName = s.fileName || s.name || ""
        if (typeof s.file === "string") {
          if (s.file.startsWith("http://") || s.file.startsWith("https://")) {
            // QQ CDN URL：通过代理才能被浏览器加载，保留原始 URL 用于发送
            originalUrl = s.file
            imageUrl = `${API_BASE}/bot/${state.currentBotId || ""}/image-proxy?url=${encodeURIComponent(s.file)}`
          } else if (s._local) {
            // 本地缓存文件：通过 local-media 端点加载
            imageUrl = `${API_BASE}/bot/${state.currentBotId || ""}/local-media?path=${encodeURIComponent(s.file)}`
          } else {
            imageUrl = "data:image/jpeg;base64," + s.file
          }
        } else if (s.file && s.file.type === "Buffer" && Array.isArray(s.file.data)) {
          try {
            const bytes = new Uint8Array(s.file.data)
            let binary = ""
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
            imageUrl = "data:image/jpeg;base64," + btoa(binary)
          } catch {}
        } else if (typeof s.url === "string") {
          originalUrl = s.url
          imageUrl = `${API_BASE}/bot/${state.currentBotId || ""}/image-proxy?url=${encodeURIComponent(s.url)}`
        } else if (typeof s.image === "string") {
          imageUrl = s.image
        }
        if (imageUrl) {
          items.push({ type: "image", imageUrl, originalUrl, fileName })
        } else {
          items.push({ type: "text", text: "[图片]" })
        }
      } else if (s.type === "at" && s.qq) {
        items.push({ type: "at", qq: s.qq, nickname: s.nickname || "" })
      }
    }
  } else {
    // 用户消息：从 raw_event 解析 content、attachment、mention
    const raw = msg.raw_event
    if (raw) {
      const d = raw.d || {}
      let content = d.content || raw.content || ""
      const attachments = d.attachments || raw.attachments || []
      const mentions = d.mentions || raw.mentions || []

      // openid → username 映射
      const mentionMap = {}
      for (const m of mentions) {
        mentionMap[m.id || m.member_openid] = m.username || ""
      }
      if (d.author?.union_openid) {
        mentionMap[d.author.union_openid] = mentionMap[d.author.union_openid] || d.author.username || ""
      }

      // 按标签拆分 content：<@xxx> → @mention, <attachmentType=...> → 图片附件, <faceType=...> → 丢弃
      let attIdx = 0
      const parts = content.split(/(<@[^>]+>|<attachmentType=[^>]+>|<faceType=[^>]+>)/g)
      for (const part of parts) {
        if (part.startsWith("<@") && part.endsWith(">")) {
          const openid = part.slice(2, -1)
          const nick = mentionMap[openid] || ""
          items.push({ type: "at", qq: openid, nickname: nick })
        } else if (part.startsWith("<attachmentType=")) {
          const att = attachments[attIdx]
          attIdx++
          if (att?.content_type?.startsWith("image/") && att.url) {
            items.push({ type: "image", imageUrl: att.url, fileName: att.filename || "" })
          } else if (att) {
            items.push({ type: "text", text: `[附件:${att.filename || ""}]` })
          } else {
            items.push({ type: "text", text: "[附件]" })
          }
        } else if (part.startsWith("<faceType=")) {
          // 跳过表情标签
        } else if (part) {
          items.push({ type: "text", text: part })
        }
      }

      // 纯图片消息（content 无文本但有附件，且 tags 未匹配到）
      const hasText = items.some(s => s.type === "text" && s.text.trim())
      const hasImage = items.some(s => s.type === "image")
      if (!hasText && !hasImage && attachments.length > 0) {
        for (const att of attachments) {
          if (att.content_type?.startsWith("image/") && att.url) {
            items.push({ type: "image", imageUrl: att.url, fileName: att.filename || "" })
          } else {
            items.push({ type: "text", text: `[附件:${att.filename || ""}]` })
          }
        }
      }

      // 引用：使用消息自身的 ref_msg_idx
      if (msg.ref_msg_idx && msg.ref_msg_idx !== msg.msg_idx) {
        refMsgIdx = msg.ref_msg_idx
      }
    } else {
      const text = extractTextFromSegments(msg.message)
      if (text) items.push({ type: "text", text })
      if (msg.ref_msg_idx && msg.ref_msg_idx !== msg.msg_idx) {
        refMsgIdx = msg.ref_msg_idx
      }
    }
  }

  // 渲染 items 到编辑器
  for (const item of items) {
    if (item.type === "text") {
      editor.appendChild(document.createTextNode(item.text))
    } else if (item.type === "at") {
      const chip = document.createElement("span")
      chip.className = "mention-chip"
      chip.contentEditable = "false"
      chip.dataset.userId = item.qq
      chip.dataset.nickname = item.nickname || ""
      chip.innerHTML = `${escHtml(item.nickname || item.qq)}<button class="mention-chip-x" type="button">&times;</button>`
      editor.appendChild(chip)
      editor.appendChild(document.createTextNode("\u00A0"))
    } else if (item.type === "image") {
      const wrapper = document.createElement("span")
      wrapper.className = "pasted-img-wrapper"
      wrapper.contentEditable = "false"
      wrapper.dataset.fileName = item.fileName || "image.jpg"
      if (item.originalUrl) wrapper.dataset.originalUrl = item.originalUrl
      const img = document.createElement("img")
      img.src = item.imageUrl
      img.className = "pasted-img-thumb"
      img.title = item.fileName || ""
      img.referrerPolicy = "no-referrer"
      const removeBtn = document.createElement("button")
      removeBtn.className = "pasted-img-remove"
      removeBtn.type = "button"
      removeBtn.innerHTML = "&times;"
      removeBtn.title = "移除此图片"
      wrapper.appendChild(img)
      wrapper.appendChild(removeBtn)
      editor.appendChild(wrapper)
      editor.appendChild(document.createTextNode("\u00A0"))
    }
  }

  // 设置引用，优先使用 ref_summary 中的昵称和概览
  if (refMsgIdx) {
    const summary = msg.ref_summary
    state.replyTo = {
      msg_idx: refMsgIdx,
      text: summary?.summary || "[引用消息]",
      nickname: summary?.nickname || ""
    }
    updateReplyPreview()
  }

  if (state.currentPage !== "messages") navigateTo("messages")
}

/** 将接收到的消息 segments 转为可发送的 segments（清理 face 段和 attachment/face 标签） */
function segmentsForEcho(message) {
  const msgSegments = Array.isArray(message.message) ? message.message : []
  if (!msgSegments.length) return []
  const flat = (Array.isArray(msgSegments[0]) && msgSegments.length > 0) ? msgSegments.flat() : msgSegments
  // 清理 segments：过滤 face 段，清洗 text 中的 <attachmentType=...> 和 <faceType=...> 标签
  const cleanTagRegex = /<(faceType|attachmentType)=[^>]*>/g
  return flat
    .filter(s => s.type !== "face")
    .map(s => {
      if (s.type === "text" && typeof s.text === "string") {
        return { ...s, text: s.text.replace(cleanTagRegex, "").trim() }
      }
      return s
    })
    .filter(s => s.type !== "text" || s.text)
}

// ===== 附件渲染 =====
function renderAttachment(att, isSelf = false, badges = "") {
  const mime = att.content_type || ""
  if (mime.startsWith("image/")) {
    return `<div class="msg-attachment-img-wrap">
      <img class="msg-attachment-img" src="${escHtml(att.url)}" alt="${escHtml(att.filename || '')}" loading="lazy"
           onclick="window.open('${escHtml(att.url)}', '_blank')" title="点击查看原图">
    </div>`
  }
  if (mime.startsWith("audio/") || mime.startsWith("voice/") || mime === "voice") {
    const audioUrl = att.voice_wav_url || att.url
    const audioId = "audio_" + Math.random().toString(36).slice(2, 8)
    const asrText = att.asr_refer_text || ""
    return `<div class="msg-attachment-audio-wrap" data-audio-id="${audioId}">
      <div class="msg-attachment-audio">
        <button class="audio-play-btn" data-audio-url="${escHtml(audioUrl)}" data-audio-id="${audioId}">
          <svg class="audio-icon-play" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><polygon points="4,2 14,8 4,14"/></svg>
          <svg class="audio-icon-pause" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="display:none"><rect x="3" y="2" width="4" height="12"/><rect x="9" y="2" width="4" height="12"/></svg>
        </button>
        <div class="audio-bar-wrap">
          <div class="audio-bar-track" id="${audioId}_track">
            <div class="audio-bar-fill" id="${audioId}_fill"></div>
            <div class="audio-bar-thumb" id="${audioId}_thumb"></div>
          </div>
          <span class="audio-time" id="${audioId}_time">0:00 / --:--</span>
        </div>
      </div>
      <audio src="${escHtml(audioUrl)}" preload="metadata" style="display:none" class="audio-metadata-loader"
        onloadedmetadata="var t=document.getElementById('${audioId}_time');if(t&&this.duration){var m=Math.floor(this.duration/60),s=Math.floor(this.duration%60);t.textContent='0:00 / '+m+':'+(s<10?'0':'')+s}"
        onerror="this.remove()"></audio>
      ${asrText ? `<div class="audio-asr">转文字: ${escHtml(asrText)}</div>` : ""}
    </div>`
  }
  if (mime.startsWith("video/")) {
    const url = escHtml(att.url)
    const videoId = "video_" + Math.random().toString(36).slice(2, 8)
    const timeUpd = `var e=document.getElementById('${videoId}_time');if(e&&this.duration&&isFinite(this.duration)){var m=Math.floor(this.currentTime/60),s=Math.floor(this.currentTime%60),dm=Math.floor(this.duration/60),ds=Math.floor(this.duration%60);e.textContent=m+':'+(s<10?'0':'')+s+' / '+dm+':'+(ds<10?'0':'')+ds}`
    const metaScript = `var e=document.getElementById('${videoId}_time');if(e&&this.duration&&isFinite(this.duration)){var dm=Math.floor(this.duration/60),ds=Math.floor(this.duration%60);e.textContent='0:00 / '+dm+':'+(ds<10?'0':'')+ds}`
    const btnHtml = `<button class="video-play-btn-circle" data-video-id="${videoId}" data-video-url="${url}">
      <svg class="video-icon-play" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><polygon points="4,2 14,8 4,14"/></svg>
      <svg class="video-icon-pause" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="display:none"><rect x="3" y="2" width="4" height="12"/><rect x="9" y="2" width="4" height="12"/></svg>
    </button>`
    const previewHtml = `<div class="msg-video-preview" onclick="window.open('${url}')" title="点击打开视频">
      <video preload="metadata" id="${videoId}" onclick="event.stopPropagation()"
        onloadedmetadata="${metaScript}" ontimeupdate="${timeUpd}">
        <source src="${url}" type="${escHtml(mime)}">
      </video>
      <div class="msg-video-time-overlay"><span class="msg-video-time" id="${videoId}_time">0:00 / 0:00</span></div>
    </div>`
    if (isSelf) {
      return `<div class="msg-video-card msg-video-self">
        <div class="msg-video-controls">
          ${badges ? `<div class="msg-video-badges-outside">${badges}</div>` : ""}
          ${btnHtml}
        </div>
        ${previewHtml}
      </div>`
    } else {
      return `<div class="msg-video-card msg-video-other">
        ${previewHtml}
        <div class="msg-video-controls">
          ${badges ? `<div class="msg-video-badges-outside">${badges}</div>` : ""}
          ${btnHtml}
        </div>
      </div>`
    }
  }
  // 其它文件类型（兼容多种字段名）
  const sizeBytes = att.size || att.file_size || att.fileSize || att.byte_size || att.byteSize || att.filesize || (att.file_info && att.file_info.size) || (att.req && att.req.QFile && att.req.QFile.filesize) || (att.raw && att.raw.size) || 0
  const size = formatFileSize(sizeBytes)
  return `<div class="msg-attachment-file">
    <div class="file-icon-wrap"><svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M6 2h6l4 4v10a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z"/><path d="M12 2v4h4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></div>
    <div class="file-info">
      <div class="file-name">${escHtml(att.filename || "未知文件")}</div>
      ${size ? `<div class="file-size">${size}</div>` : ""}
    </div>
    <a class="file-download-btn" href="${escHtml(att.url)}" download="${escHtml(att.filename || 'file')}" target="_blank" title="下载文件">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 11V2M5 8l3 3 3-3M3 13h10"/></svg>
    </a>
  </div>`
}

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return ""
  if (bytes < 1024) return bytes + " B"
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"
  return (bytes / (1024 * 1024)).toFixed(1) + " MB"
}

// ===== 输入框辅助 =====

/** 遍历编辑器 DOM，返回 segments 数组（文本+at+图片混合） */
function getEditorSegments() {
  const editor = $("#chatInput")
  const segments = []
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      segments.push({ type: "text", text: node.textContent })
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList && node.classList.contains("mention-chip")) {
        const uid = node.dataset.userId || ""
        const nick = node.dataset.nickname || _mentionNickCache[uid] || ""
        segments.push({ type: "at", qq: uid, nickname: nick })
      } else if (node.classList && node.classList.contains("pasted-img-wrapper")) {
        const img = node.querySelector("img")
        if (!img) return
        // 优先用原始 File 对象（发送时二进制协议一发带走）
        if (node._file) {
          segments.push({ type: "image", _file: node._file, fileName: node.dataset.fileName || "paste.png" })
        } else if (node.dataset.originalUrl) {
          segments.push({ type: "image", file: node.dataset.originalUrl, fileName: node.dataset.fileName || "image.jpg" })
        } else if (img.src.startsWith("http://") || img.src.startsWith("https://")) {
          segments.push({ type: "image", file: img.src, fileName: node.dataset.fileName || "image.jpg" })
        } else if (img.src.startsWith("data:image/")) {
          // 兜底：没有 File 对象但有 data URL，转成 Blob 发送
          try {
            const mime = img.src.match(/^data:(image\/\w+);/)?.[1] || "image/png"
            const b64 = img.src.replace(/^data:image\/\w+;base64,/, "")
            const byteChars = atob(b64)
            const byteNums = new Array(byteChars.length)
            for (let j = 0; j < byteChars.length; j++) byteNums[j] = byteChars.charCodeAt(j)
            const blob = new Blob([new Uint8Array(byteNums)], { type: mime })
            segments.push({ type: "image", _file: blob, fileName: node.dataset.fileName || "paste.png" })
          } catch {
            // data URL 解析失败，跳过
          }
        }
      } else if (node.classList && node.classList.contains("chat-image-inline")) {
        // 表情包插入的图片：直接当本地图片发送（不经过图床）
        const url = node.getAttribute("data-url") || node.src
        if (url) {
          const m = url.match(/\/emoji-static\/([^/]+)\/(.+)$/)
          const rel = m ? `data/emoji/${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}` : url
          segments.push({ type: "image", file: rel, fileName: node.getAttribute("data-name") || "emoji.png" })
        }
      } else if (node.tagName === "BR") {
        segments.push({ type: "text", text: "\n" })
      } else {
        node.childNodes.forEach(walk)
      }
    }
  }
  editor.childNodes.forEach(walk)
  return segments
}

/** 提取编辑器纯文本（用于旧逻辑兼容） */
function getEditorContent() {
  return getEditorSegments()
    .map(s => s.type === "at" ? `<@${s.qq}>` : s.type === "image" ? "" : s.text)
    .join("")
}

/** 保存编辑器失焦前的光标位置 */
let savedEditorRange = null

/** 在光标处插入 @ 提及胶囊 */
function insertMention(userId, nickname) {
  const editor = $("#chatInput")
  editor.focus()

  // 恢复上次光标位置（优先使用保存的 range）
  const sel = window.getSelection()
  let range = null

  // 优先用已保存的 range（需校验 range 仍在 editor 内且在 DOM 中）
  if (savedEditorRange) {
    const r = savedEditorRange
    savedEditorRange = null
    try {
      if (r.startContainer && editor.contains(r.startContainer)) {
        range = r
      }
    } catch {}
  }
  if (!range && sel.rangeCount) {
    const r = sel.getRangeAt(0)
    try {
      if (r.startContainer && editor.contains(r.startContainer)) {
        range = r
      }
    } catch {}
  }

  // 还没有有效 range → 插入到末尾
  if (!range) {
    range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
  }

  // 将选区恢复到 editor 内
  sel.removeAllRanges()
  sel.addRange(range)

  // 在光标前加空格（如果前面不是空格/行首）
  const textBefore = range.startContainer.textContent?.slice(0, range.startOffset) || ""
  if (textBefore && !textBefore.endsWith(" ") && !textBefore.endsWith("\n") && range.startOffset > 0) {
    range.insertNode(document.createTextNode(" "))
    // insertNode 后 range 已自动定位到 " " 之后，无需手动 setStartAfter
  }

  // 创建胶囊
  const chip = document.createElement("span")
  chip.className = "mention-chip"
  chip.contentEditable = "false"
  chip.dataset.userId = userId
  chip.dataset.nickname = nickname || ""
  chip.innerHTML = `${escHtml(nickname || userId)}<button class="mention-chip-x" type="button">&times;</button>`

  range.insertNode(chip)

  // 胶囊后加一个空格，光标移到空格后
  const space = document.createTextNode("\u00A0")
  range.setStartAfter(chip)
  range.collapse(true)
  range.insertNode(space)

  range.setStartAfter(space)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)

  editor.dispatchEvent(new Event("input", { bubbles: true }))
}

// ===== 粘贴图片处理 =====

function handleEditorPaste(e) {
  const items = e.clipboardData?.items
  if (!items) return

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.type.startsWith("image/")) {
      e.preventDefault()
      const file = item.getAsFile()
      if (!file) continue

      const reader = new FileReader()
      reader.onload = () => {
        const mimeType = item.type
        const ext = mimeType.split("/")[1] || "png"
        const now = new Date()
        const pad = n => String(n).padStart(2, "0")
        const fileName = `paste_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`
        insertPastedImage(fileName, reader.result, file)
      }
      reader.readAsDataURL(file)
      break
    }
  }
}

function insertPastedImage(fileName, dataUrl, file) {
  const editor = $("#chatInput")
  editor.focus()

  // 获取光标位置
  const sel = window.getSelection()
  let range
  if (savedEditorRange) {
    const r = savedEditorRange
    savedEditorRange = null
    try {
      if (r.startContainer && editor.contains(r.startContainer)) {
        range = r
      }
    } catch {}
  }
  if (!range && sel.rangeCount) {
    const r = sel.getRangeAt(0)
    try {
      if (r.startContainer && editor.contains(r.startContainer)) {
        range = r
      }
    } catch {}
  }

  if (!range) {
    range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
  }

  sel.removeAllRanges()
  sel.addRange(range)

  // 创建图片预览容器
  const wrapper = document.createElement("span")
  wrapper.className = "pasted-img-wrapper"
  wrapper.contentEditable = "false"
  wrapper.dataset.fileName = fileName

  const img = document.createElement("img")
  img.src = dataUrl
  img.className = "pasted-img-thumb"
  img.title = fileName

  const removeBtn = document.createElement("button")
  removeBtn.className = "pasted-img-remove"
  removeBtn.type = "button"
  removeBtn.innerHTML = "&times;"
  removeBtn.title = "移除此图片"

  wrapper.appendChild(img)
  wrapper.appendChild(removeBtn)

  range.insertNode(wrapper)

  // wrapper 后加空格，光标移到空格后
  const space = document.createTextNode("\u00A0")
  range.setStartAfter(wrapper)
  range.collapse(true)
  range.insertNode(space)

  range.setStartAfter(space)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)

  editor.dispatchEvent(new Event("input", { bubbles: true }))

  // 存储 File 对象，发送时通过二进制协议一次性发送（无需后台上传）
  if (file) {
    wrapper._file = file
  }
}

// ===== 音频播放管理 =====
let currentAudio = null   // { audio: HTMLAudioElement, audioId: string, instanceId: number }
let currentVideo = null   // { video: HTMLVideoElement, videoId: string }
let audioInstanceCounter = 0

function toggleAudioPlay(el) {
  const url = el.dataset.audioUrl
  const audioId = el.dataset.audioId
  if (!url || !audioId) return

  // 如果点击的是正在播放的同一个音频，切换暂停/播放
  if (currentAudio && currentAudio.audioId === audioId) {
    if (currentAudio.audio.paused) {
      stopCurrentVideo()
      currentAudio.audio.play()
      setAudioBtnState(el, true)
    } else {
      currentAudio.audio.pause()
      setAudioBtnState(el, false)
    }
    return
  }

  // 彻底停止当前播放的音频和视频
  stopAllMedia()

  // 创建新的音频元素，分配唯一实例ID
  const instanceId = ++audioInstanceCounter
  const audio = new Audio(url)
  audio.preload = "auto"

  const parent = el.closest(".msg-attachment-audio-wrap")
  const track = parent?.querySelector(".audio-bar-track")
  const fill = parent?.querySelector(".audio-bar-fill")
  const thumb = parent?.querySelector(".audio-bar-thumb")
  const timeEl = parent?.querySelector(".audio-time")

  currentAudio = { audio, audioId, instanceId }

  // 所有回调只对当前活跃实例生效
  const isActive = () => currentAudio?.instanceId === instanceId

  audio.addEventListener("loadedmetadata", () => {
    if (!isActive()) return
    if (timeEl) timeEl.textContent = `0:00 / ${fmtDuration(audio.duration)}`
  })

  audio.addEventListener("timeupdate", () => {
    if (!isActive()) return
    const pct = audio.duration ? audio.currentTime / audio.duration * 100 : 0
    if (fill) fill.style.width = pct + "%"
    if (thumb) thumb.style.left = pct + "%"
    if (timeEl) timeEl.textContent = `${fmtDuration(audio.currentTime)} / ${fmtDuration(audio.duration)}`
  })

  audio.addEventListener("ended", () => {
    if (!isActive()) return
    setAudioBtnState(el, false)
    if (fill) fill.style.width = "0"
    if (thumb) thumb.style.left = "0"
    if (timeEl && audio.duration) timeEl.textContent = `0:00 / ${fmtDuration(audio.duration)}`
    currentAudio = null
  })

  audio.addEventListener("error", () => {
    if (!isActive()) return
    setAudioBtnState(el, false)
    if (timeEl) timeEl.textContent = "播放失败"
    currentAudio = null
  })

  // 进度条点击跳转
  if (track) {
    const onTrackClick = (e) => {
      if (!isActive() || !audio.duration) return
      const rect = track.getBoundingClientRect()
      const pct = (e.clientX - rect.left) / rect.width
      audio.currentTime = pct * audio.duration
    }
    track.addEventListener("click", onTrackClick)
  }

  audio.play().then(() => {
    if (!isActive()) return
    setAudioBtnState(el, true)
  }).catch(() => {
    if (!isActive()) return
    if (timeEl) timeEl.textContent = "播放失败"
    currentAudio = null
  })
}

function stopCurrentAudio() {
  if (!currentAudio) return
  const { audio, audioId } = currentAudio
  currentAudio = null
  audio.pause()
  audio.removeAttribute("src")
  audio.load()
  const stoppedBtn = document.querySelector(`.audio-play-btn[data-audio-id="${audioId}"]`)
  if (stoppedBtn) setAudioBtnState(stoppedBtn, false)
}

function stopCurrentVideo() {
  if (!currentVideo) return
  const { video, videoId } = currentVideo
  currentVideo = null
  video.pause()
  const btn = document.querySelector(`.video-play-btn-circle[data-video-id="${videoId}"]`)
  if (btn) setVideoBtnState(btn, false)
}

function stopAllMedia() {
  stopCurrentAudio()
  stopCurrentVideo()
}

function setAudioBtnState(btn, playing) {
  const playIcon = btn.querySelector(".audio-icon-play")
  const pauseIcon = btn.querySelector(".audio-icon-pause")
  if (playIcon) playIcon.style.display = playing ? "none" : ""
  if (pauseIcon) pauseIcon.style.display = playing ? "" : "none"
  btn.classList.toggle("playing", playing)
}

function toggleVideoPlay(el) {
  const videoId = el.dataset.videoId
  const videoUrl = el.dataset.videoUrl
  if (!videoId) return

  const video = document.getElementById(videoId)
  if (!video) return

  // 点击同一视频：切换暂停/播放
  if (currentVideo && currentVideo.videoId === videoId) {
    if (video.paused) {
      stopCurrentAudio()
      video.play().then(() => setVideoBtnState(el, true)).catch(err => {
        console.error("视频恢复播放失败:", err, "URL:", videoUrl)
      })
    } else {
      video.pause()
      setVideoBtnState(el, false)
    }
    return
  }

  // 停止所有在播媒体
  stopAllMedia()

  // 确保 source 正确加载（某些情况下浏览器可能需要重新设置）
  if (videoUrl && (!video.querySelector("source") || video.querySelector("source").src !== videoUrl)) {
    video.innerHTML = `<source src="${videoUrl.replace(/&/g, "&amp;")}">`
  }

  // 播放结束回调
  const onEnded = () => {
    currentVideo = null
    setVideoBtnState(el, false)
    video.removeEventListener("ended", onEnded)
  }
  video.addEventListener("ended", onEnded)

  currentVideo = { video, videoId }

  video.play().then(() => {
    setVideoBtnState(el, true)
  }).catch(err => {
    console.error("视频播放失败:", err, "URL:", videoUrl)
    const timeEl = document.getElementById(videoId + "_time")
    if (timeEl) timeEl.textContent = "无法播放，已打开新窗口"
    // H.265 等浏览器不支持的编码无法内联播放，回退到新窗口打开原视频
    if (videoUrl) window.open(videoUrl, "_blank")
    currentVideo = null
    video.removeEventListener("ended", onEnded)
  })
}

function setVideoBtnState(btn, playing) {
  const playIcon = btn.querySelector(".video-icon-play")
  const pauseIcon = btn.querySelector(".video-icon-pause")
  if (playIcon) playIcon.style.display = playing ? "none" : ""
  if (pauseIcon) pauseIcon.style.display = playing ? "" : "none"
  btn.classList.toggle("playing", playing)
}

function fmtDuration(secs) {
  if (!secs || !isFinite(secs)) return "0:00"
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${String(s).padStart(2, "0")}`
}

function updateReplyPreview() {
  const preview = $("#replyPreview")
  const text = $("#replyPreviewText")

  if (state.replyTo) {
    preview.style.display = "flex"
    const nick = state.replyTo.nickname ? ` ${state.replyTo.nickname}:` : ""
    text.textContent = `引用:${nick} ${state.replyTo.text}`
  } else {
    preview.style.display = "none"
    text.textContent = ""
  }
}

function updateMsgIdReplyPreview() {
  const preview = $("#msgIdReplyPreview")
  const text = $("#msgIdReplyPreviewText")
  const toggle = $("#replyMsgIdToggle")

  // 同步开关状态到 checkbox
  if (toggle) toggle.checked = state.useReplyMsgId

  if (state.replyMsgId) {
    preview.style.display = "flex"
    text.textContent = `回复 message_id: ${state.replyMsgId.message_id.slice(0, 30)}... — ${state.replyMsgId.text}`
  } else {
    preview.style.display = "none"
    text.textContent = ""
  }
}

function updateEventIdReplyPreview() {
  const preview = $("#eventIdReplyPreview")
  const text = $("#eventIdReplyPreviewText")
  if (!preview) return

  if (state.replyEventId) {
    preview.style.display = "flex"
    text.textContent = `回复 event_id: ${state.replyEventId.event_id.slice(0, 30)}... — ${state.replyEventId.text}`
  } else {
    preview.style.display = "none"
    text.textContent = ""
  }
}

/** 将用户手打的 \n \r \t \\ 等转义序列还原为真实字符 */
function unescapeInput(str) {
  if (!str) return str
  return str.replace(/\\(.)/g, (_, ch) => {
    switch (ch) {
      case "n": return "\n"
      case "r": return "\r"
      case "t": return "\t"
      case "\\": return "\\"
      default: return "\\" + ch  // 不认识的保持原样
    }
  })
}

// ===== 图片上传辅助（用于发送前上传，避免大 base64 导致 JSON.stringify 栈溢出） =====

/** 上传 File 对象到服务端 /upload-image-raw，返回 URL（避免大 base64 导致 JSON.stringify 栈溢出） */
async function uploadFileForSend(file, fileName) {
  const res = await fetch(`${API_BASE}/bot/${state.currentBotId}/upload-image-raw`, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/x-upload",
      "X-File-Name": encodeURIComponent(fileName || file.name || "image.png"),
      "X-Mime-Type": file.type || "image/png",
    },
    credentials: "include", // 携带 cookie 用于鉴权
    body: file, // 直接发送 Blob/File，不走 JSON
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || "上传失败")
  }
  const data = await res.json()
  if (!data.url) throw new Error("上传失败，未返回 URL")
  return data.url
}

/** 将本地表情图片（/web/emoji-static/...）按"上传文件"方式上传到图床（Bot.imageToUrl），返回真实外链 */
async function uploadLocalImageForSend(localUrl, fileName) {
  const resp = await fetch(localUrl, { credentials: "include" })
  if (!resp.ok) throw new Error("读取本地图片失败")
  const blob = await resp.blob()
  return await uploadFileForSend(blob, fileName || "emoji.png")
}

// ===== 消息发送 =====
async function sendMessage() {
  if (state._sending) return
  state._sending = true

  const chatId = state.chatType === "group" ? state.currentGroupId : state.currentPrivateUserId
  if (!state.currentBotId || !chatId) { state._sending = false; return }

  const editor = $("#chatInput")
  const msgType = state.messageType // "legacy" | "markdown" | "ark" | "media"

  let body, isBinary = false
  if (msgType === "ark") {
    const arkSeg = buildArkSegment()
    if (!arkSeg) return
    body = JSON.stringify({ segments: [arkSeg] })
  } else {
    // 普通/MD 消息：从编辑器构建 segments
    const rawSegments = getEditorSegments()
    const hasContent = rawSegments.some(s => s.type === "text" ? s.text.trim() : s.type === "image" ? true : false)
    if (!hasContent) { state._sending = false; return }

    // 收集 Blob 图片（粘贴图片），表情图片以本地相对路径直接发送，不经图床
    const blobs = []
    const segments = rawSegments.map(s => {
      if (s.type === "image" && s._file instanceof Blob) {
        const idx = blobs.length
        blobs.push(s._file)
        return { type: "image", file: `{img:${idx}}`, fileName: s.fileName }
      }
      return s
    }).filter(s => {
      if (s.type === "image") return s.file // 有 file/URL 才保留
      return true
    })

    // 构建请求体内容
    const jsonPayload = { segments: segments.map(s => {
      switch (s.type) {
        case "text":  return { type: "text", text: unescapeInput(s.text) }
        case "at":    return { type: "at", qq: s.qq }
        case "image": return { type: "image", file: s.file, fileName: s.fileName }
        default:      return { type: "text", text: "" }
      }
    }).filter(s => s.type === "text" ? s.text : true) }

    // 回复信息
    // 发送前先同步当前展开的按钮构造区到 state.mdButtons（避免未收起直接发送丢失按钮）
    if (msgType === "markdown" && mdBtnGridWrap && typeof mdBtnGridWrap._getButtons === "function"
        && $("#mdBtnInline") && $("#mdBtnInline").style.display !== "none") {
      state.mdButtons = mdBtnGridWrap._getButtons()
    }
    if (state.replyTo) jsonPayload.reply_msg_idx = state.replyTo.msg_idx
    if (state.replyEventId) jsonPayload.reply_event_id = state.replyEventId.event_id
    else if (state.replyMsgId) jsonPayload.reply_msg_id = state.replyMsgId.message_id
    else if (state.useReplyMsgId && state.messages.length > 0) {
      let latestOther = null
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i]
        if (!m.me && m.message_id) { latestOther = m; break }
      }
      if (latestOther) jsonPayload.reply_msg_id = latestOther.message_id
    }

    // MD 消息按钮：作为 button 类型 segment 并入 segments 末尾（仅 MD 消息类型）
    if (msgType === "markdown" && Array.isArray(state.mdButtons) && state.mdButtons.length) {
      jsonPayload.segments.push({ type: "button", data: state.mdButtons })
    }

    if (blobs.length > 0) {
      // 二进制协议：一次性发送 JSON + Blob 数据
      const jsonBytes = new TextEncoder().encode(JSON.stringify(jsonPayload))
      const parts = []
      // [4 bytes LE: jsonLen]
      const jsonLenBuf = new ArrayBuffer(4)
      new DataView(jsonLenBuf).setUint32(0, jsonBytes.length, true)
      parts.push(jsonLenBuf)
      // JSON bytes
      parts.push(jsonBytes)
      // [4 bytes LE: blobCount]
      const blobCountBuf = new ArrayBuffer(4)
      new DataView(blobCountBuf).setUint32(0, blobs.length, true)
      parts.push(blobCountBuf)
      // 每个 blob: [4 bytes LE: blobLen][blob data]
      for (const blob of blobs) {
        const blobLenBuf = new ArrayBuffer(4)
        new DataView(blobLenBuf).setUint32(0, blob.size, true)
        parts.push(blobLenBuf)
        parts.push(blob)
      }
      body = new Blob(parts, { type: "application/x-qqbot-bin" })
      isBinary = true
    } else {
      body = JSON.stringify(jsonPayload)
    }
  }

  const sendBtn = $("#chatSendBtn")
  sendBtn.disabled = true

  try {
    const prefix = state.chatType === "group" ? "group" : "private"
    console.log("[sendMessage] 发送中, chatType:", state.chatType, "msgType:", msgType, "binary:", isBinary)
    const headers = { "X-Msg-Type": msgType }
    if (isBinary) {
      headers["Content-Type"] = "application/x-qqbot-bin"
      headers["X-Bin-Protocol"] = "1"
    } else {
      headers["Content-Type"] = "application/json"
    }
    const sendRes = await api(`/bot/${state.currentBotId}/${prefix}/${chatId}/send`, {
      method: "POST",
      headers,
      body,
    })
    if (sendRes.success === false) {
      throw new Error(sendRes.error || "发送失败")
    }
    console.log("[sendMessage] 发送成功, 增量刷新")
    if (msgType !== "ark") { editor.innerHTML = "" }
    state.replyTo = null
    state.replyMsgId = null
    state.replyEventId = null
    state.mdButtons = []
    updateReplyPreview()
    updateMsgIdReplyPreview()
    updateEventIdReplyPreview()
    refreshAfterBotSend(chatId, sendRes?.audit_id || null)
  } catch (err) {
    console.error("发送消息失败:", err)
    alert("发送失败: " + err.message)
  } finally {
    state._sending = false
    sendBtn.disabled = false
    editor.focus()
  }
}

// ===== MD 消息按钮构造（复用 replacebutton 风格的网格 + 编辑弹窗）=====
const MD_MAX_ROWS = 5
const MD_MAX_COLS = 10

let mdBtnGridWrap = null   // 当前网格 wrap，含 _getButtons / _grid / _rerender
let mdBtnCtx = null        // 按钮编辑上下文 { mode, row, col, btn }
let mdBtnType = "input"
let mdBtnDragCtx = null

function mdToast(msg) {
  let el = $("#mdBtnToast")
  if (!el) {
    el = document.createElement("div")
    el.id = "mdBtnToast"
    el.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);background:rgba(31,35,41,.88);color:#fff;padding:10px 18px;border-radius:8px;font-size:14px;z-index:300;display:none;max-width:90%;text-align:center"
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.style.display = "block"
  clearTimeout(el._t)
  el._t = setTimeout(() => { el.style.display = "none" }, 2200)
}

function mdOpenBuilder() {
  renderMdBtnGrid()
  $("#mdBtnInline").style.display = ""
  $("#chatMdBtnBtn").classList.add("active")
}

function mdCloseBuilder(save) {
  if (save && mdBtnGridWrap && typeof mdBtnGridWrap._getButtons === "function") {
    state.mdButtons = mdBtnGridWrap._getButtons()
  }
  $("#mdBtnInline").style.display = "none"
  $("#chatMdBtnBtn").classList.remove("active")
}

function mdHideInline() {
  const el = $("#mdBtnInline")
  if (el) el.style.display = "none"
  const btn = $("#chatMdBtnBtn")
  if (btn) btn.classList.remove("active")
}

function mdRenderBtnEditFields() {
  const wrap = $("#mdB_type_field")
  const t = MD_BTN_TYPES.find(x => x.id === mdBtnType)
  wrap.innerHTML = ""
  const lab = document.createElement("label")
  lab.textContent = t.needLabel
  const inp = document.createElement("input")
  inp.id = "mdB_need"
  const cur = mdBtnCtx?.btn
  inp.value = cur ? (cur[t.need] || "") : ""
  inp.placeholder = t.need === "link" ? "https://example.com" : "输入内容"
  wrap.append(lab, inp)

  if (t.id === "input" || t.id === "callback") {
    wrap.appendChild(mdPillOption("mdB_reply", "引用消息（reply）：点击后引用该条消息", !!(cur && cur.reply)))
  }
  if (t.id === "input") {
    wrap.appendChild(mdPillOption("mdB_send", "点击后自动发送（send）", !!(cur && cur.send)))
  }
}

function mdPillOption(id, text, checked) {
  const row = document.createElement("div")
  row.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-top:12px"
  const lab = document.createElement("label")
  lab.textContent = text
  lab.style.cssText = "font-size:13px;color:var(--text-secondary);cursor:pointer"
  const sw = document.createElement("button")
  sw.type = "button"
  sw.className = "pill-switch" + (checked ? " on" : "")
  sw.id = id
  sw.title = text
  const knob = document.createElement("span")
  knob.className = "knob"
  sw.appendChild(knob)
  sw.onclick = () => sw.classList.toggle("on")
  lab.onclick = () => sw.classList.toggle("on")
  row.append(lab, sw)
  return row
}

const MD_BTN_TYPES = [
  { id: "input", name: "输入按钮", need: "input", needLabel: "输入框内容 input（点击后自动填入）" },
  { id: "callback", name: "自动发送", need: "callback", needLabel: "发送内容 callback（点击后直接发送）" },
  { id: "link", name: "链接按钮", need: "link", needLabel: "跳转链接 link（https://...）" },
  { id: "toCallback", name: "回调按钮", need: "callback", needLabel: "回调数据 callback" },
]

function mdOpenBtnEdit(row, col, btn) {
  mdBtnCtx = { mode: btn ? "edit" : "add", row, col, btn: btn || null }
  $("#mdBtnEditTitle").textContent = btn ? "编辑按钮" : "添加按钮"
  $("#mdBtnEditDel").style.display = btn ? "inline-flex" : "none"

  const tabs = $("#mdBtnTypeTabs")
  tabs.innerHTML = ""
  let initType = "input"
  if (btn) {
    if (btn.link) initType = "link"
    else if (btn.toCallback) initType = "toCallback"
    else if (btn.reply) initType = btn.callback ? "callback" : "input"
    else if (btn.callback) initType = "callback"
    else if (btn.input) initType = "input"
  }
  mdBtnType = initType
  MD_BTN_TYPES.forEach(t => {
    const tab = document.createElement("div")
    tab.className = "type-tab" + (t.id === mdBtnType ? " active" : "")
    tab.textContent = t.name
    tab.onclick = () => {
      mdBtnType = t.id
      mdRenderBtnEditFields()
      ;[...tabs.children].forEach(c => c.classList.remove("active"))
      tab.classList.add("active")
    }
    tabs.appendChild(tab)
  })
  mdRenderBtnEditFields()

  $("#mdB_text").value = btn?.text || ""
  $("#mdB_style").value = btn?.style != null ? String(btn.style) : ""
  $("#mdB_clicked").value = btn?.clicked_text || ""
  const perm = btn?.permission
  $("#mdB_perm").value = Array.isArray(perm) ? perm.join(",") : (perm || "")
  $("#mdB_content").value = btn?.content || ""
  $("#mdB_confirm").value = btn?.confirm_text || ""
  $("#mdB_cancel").value = btn?.cancel_text || ""

  $("#mdBtnEditOverlay").style.display = "flex"
}

function mdSaveBtn() {
  if (!mdBtnCtx) return
  const text = $("#mdB_text").value.trim()
  if (!text) { mdToast("显示文本 text 不能为空"); return }
  const needVal = $("#mdB_need").value.trim()

  const obj = { text }
  if (needVal) obj[MD_BTN_TYPES.find(t => t.id === mdBtnType).need] = needVal
  if (mdBtnType === "toCallback") obj.toCallback = true
  if ((mdBtnType === "input" || mdBtnType === "callback") && $("#mdB_reply")?.classList.contains("on")) obj.reply = true
  if (mdBtnType === "input" && $("#mdB_send")?.classList.contains("on")) obj.send = true

  const style = $("#mdB_style").value
  if (style) obj.style = Number(style)
  const clicked = $("#mdB_clicked").value.trim()
  if (clicked) obj.clicked_text = clicked

  const permRaw = $("#mdB_perm").value.trim()
  if (permRaw) {
    if (permRaw === "admin") obj.permission = "admin"
    else {
      const ids = permRaw.split(",").map(s => s.trim()).filter(Boolean)
      if (ids.length) obj.permission = ids.length === 1 && /^\d+$/.test(ids[0]) ? Number(ids[0]) : ids
    }
  }
  const content = $("#mdB_content").value.trim()
  if (content) {
    obj.content = content
    const cf = $("#mdB_confirm").value.trim()
    if (cf) obj.confirm_text = cf
    const cc = $("#mdB_cancel").value.trim()
    if (cc) obj.cancel_text = cc
  }

  const grid = mdBtnGridWrap._grid
  const { row, col } = mdBtnCtx
  while (grid.length <= row) grid.push([])
  while (grid[row].length <= col) grid[row].push(null)
  grid[row][col] = obj
  mdBtnGridWrap._rerender()
  mdCloseBtnEdit()
}

function mdCloseBtnEdit() {
  $("#mdBtnEditOverlay").style.display = "none"
  mdBtnCtx = null
}

function mdDelBtnFromGrid() {
  if (!mdBtnCtx || !mdBtnCtx.btn) return mdCloseBtnEdit()
  const grid = mdBtnGridWrap._grid
  if (grid[mdBtnCtx.row]) grid[mdBtnCtx.row][mdBtnCtx.col] = null
  mdBtnGridWrap._rerender()
  mdCloseBtnEdit()
}

function mdHandleRowDrop(srcRow, dstRow, grid) {
  if (srcRow === dstRow) return
  const row = grid.splice(srcRow, 1)[0]
  grid.splice(dstRow, 0, row)
  mdBtnGridWrap._rerender()
}

function mdHandleDrop(srcRow, srcCol, dstRow, dstCol, grid) {
  if (srcRow === dstRow && srcCol === dstCol) return
  const srcBtn = grid[srcRow]?.[srcCol]
  if (!srcBtn) return
  while (grid.length <= dstRow) grid.push([])
  while (grid[dstRow].length <= dstCol) grid[dstRow].push(null)
  const dstBtn = grid[dstRow][dstCol]
  grid[srcRow][srcCol] = null
  grid[dstRow][dstCol] = srcBtn
  if (dstBtn) grid[srcRow][srcCol] = dstBtn
  for (let i = grid.length - 1; i >= 0; i--) {
    while (grid[i].length && grid[i][grid[i].length - 1] === null) grid[i].pop()
    if (grid[i].length === 0) grid.splice(i, 1)
  }
  if (grid.length === 0) grid.push([null])
  mdBtnGridWrap._rerender()
}

function renderMdBtnGrid() {
  const host = $("#mdBtnGridHost")
  host.innerHTML = ""
  let grid = (Array.isArray(state.mdButtons) ? state.mdButtons : []).map(row => {
    if (!Array.isArray(row)) return [null]
    return row.length ? row.slice() : [null]
  })
  if (grid.length === 0) grid = [[null]]

  const wrap = document.createElement("div")
  wrap.className = "md-btn-grid-wrap"
  const gridEl = document.createElement("div")
  gridEl.className = "md-btn-grid"

  const gridHead = document.createElement("div")
  gridHead.className = "md-grid-head"
  const limit = document.createElement("span")
  limit.className = "limit"
  gridHead.append(limit)

  const bottom = document.createElement("div")
  bottom.style.cssText = "margin-top:10px;display:flex;justify-content:center"
  const addRowBtn = document.createElement("button")
  addRowBtn.type = "button"
  addRowBtn.className = "btn btn-sm"
  addRowBtn.textContent = "+ 添加行"
  addRowBtn.style.cssText = "width:100%;justify-content:center"
  bottom.append(addRowBtn)

  function renderGrid() {
    gridEl.innerHTML = ""
    grid.forEach((row, ri) => {
      const rowEl = document.createElement("div")
      rowEl.className = "md-grid-row"

      const rowDrag = document.createElement("span")
      rowDrag.className = "md-icon-btn md-row-drag"
      rowDrag.textContent = "⠿"
      rowDrag.title = "拖动换行"
      rowDrag.draggable = true
      rowDrag.addEventListener("dragstart", (e) => {
        mdBtnDragCtx = { type: "row", row: ri }
        rowEl.style.opacity = "0.4"
        e.dataTransfer.effectAllowed = "move"
        e.dataTransfer.setData("text/plain", "row")
      })
      rowDrag.addEventListener("dragend", () => {
        rowEl.style.opacity = ""
        gridEl.querySelectorAll(".drag-over-row").forEach(el => el.classList.remove("drag-over-row"))
        mdBtnDragCtx = null
      })
      rowEl.appendChild(rowDrag)
      rowEl.addEventListener("dragover", (e) => {
        if (mdBtnDragCtx && mdBtnDragCtx.type === "row") { e.preventDefault(); rowEl.classList.add("drag-over-row") }
      })
      rowEl.addEventListener("dragleave", () => rowEl.classList.remove("drag-over-row"))
      rowEl.addEventListener("drop", (e) => {
        e.preventDefault()
        rowEl.classList.remove("drag-over-row")
        if (mdBtnDragCtx && mdBtnDragCtx.type === "row") mdHandleRowDrop(mdBtnDragCtx.row, ri, grid)
      })

      const cols = Math.max(row.length, 1)
      for (let ci = 0; ci < cols; ci++) {
        const btn = row[ci] || null
        const cell = document.createElement("div")
        cell.className = "md-cell " + (btn ? "filled" : "empty")
        if (btn) {
          const t = document.createElement("div")
          t.className = "ctext"
          t.textContent = btn.text || "(空文本)"
          cell.appendChild(t)
          if (btn.style) {
            const s = document.createElement("span")
            s.className = "cstyle"
            s.textContent = "S" + btn.style
            cell.appendChild(s)
          }
          const d = document.createElement("div")
          d.className = "cell-del"
          d.textContent = "×"
          d.onclick = (e) => { e.stopPropagation(); row[ci] = null; renderGrid() }
          cell.appendChild(d)

          let pressTimer = null, isDrag = false, dragDone = false, startX = 0, startY = 0
          const PRESS = 500
          cell.addEventListener("contextmenu", (e) => e.preventDefault())
          cell.addEventListener("pointerdown", (e) => {
            if (e.pointerType === "mouse" && e.button !== 0) return
            if (e.target.closest(".cell-del")) return
            e.preventDefault()
            startX = e.clientX; startY = e.clientY
            isDrag = false; dragDone = false
            cell.classList.add("long-pressing")
            pressTimer = setTimeout(() => {
              isDrag = true
              cell.classList.remove("long-pressing")
              cell.classList.add("dragging")
              const f = document.createElement("div")
              f.className = "btn-drag-floater"
              f.innerHTML = (cell.querySelector(".ctext")?.outerHTML || "") + (cell.querySelector(".cstyle")?.outerHTML || "")
              f.style.left = e.clientX + "px"; f.style.top = e.clientY + "px"
              f.id = "__md_drag_floater"
              document.body.appendChild(f)
              cell.setPointerCapture(e.pointerId)
            }, PRESS)
          })
          cell.addEventListener("pointermove", (e) => {
            if (pressTimer) {
              if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) { clearTimeout(pressTimer); pressTimer = null; cell.classList.remove("long-pressing") }
              return
            }
            if (!isDrag) return
            const f = document.getElementById("__md_drag_floater")
            if (f) { f.style.left = e.clientX + "px"; f.style.top = e.clientY + "px" }
            gridEl.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"))
            const tgt = document.elementFromPoint(e.clientX, e.clientY)
            if (tgt) { const tc = tgt.closest(".md-cell"); if (tc && tc !== cell && gridEl.contains(tc)) tc.classList.add("drag-over") }
          })
          const finishDrag = (e) => {
            clearTimeout(pressTimer); pressTimer = null
            cell.classList.remove("long-pressing")
            if (!isDrag) return
            isDrag = false; dragDone = true
            cell.classList.remove("dragging")
            const f = document.getElementById("__md_drag_floater"); if (f) f.remove()
            gridEl.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"))
            try { cell.releasePointerCapture(e.pointerId) } catch (_) {}
            const tgt = e ? document.elementFromPoint(e.clientX, e.clientY) : null
            if (tgt) {
              const tc = tgt.closest(".md-cell")
              if (tc && tc !== cell && gridEl.contains(tc)) {
                const rows = Array.from(gridEl.querySelectorAll(".md-grid-row"))
                const dstRow = rows.indexOf(tc.parentNode)
                const dstCol = Array.from(tc.parentNode.querySelectorAll(".md-cell")).indexOf(tc)
                if (dstRow >= 0 && dstCol >= 0) mdHandleDrop(ri, ci, dstRow, dstCol, grid)
              }
            }
          }
          cell.addEventListener("pointerup", finishDrag)
          cell.addEventListener("pointercancel", finishDrag)
          cell.onclick = () => { if (dragDone) { dragDone = false; return } mdOpenBtnEdit(ri, ci, btn) }
        } else {
          cell.textContent = "+"
          cell.onclick = () => mdOpenBtnEdit(ri, ci, null)
        }
        rowEl.appendChild(cell)
      }
      const addCol = document.createElement("button")
      addCol.type = "button"
      addCol.className = "md-icon-btn add"
      addCol.textContent = "+"
      addCol.title = "在该行右侧添加按钮"
      addCol.onclick = () => { if (row.length >= MD_MAX_COLS) { mdToast(`最多 ${MD_MAX_COLS} 列`); return } row.push(null); renderGrid() }
      rowEl.appendChild(addCol)
      const rd = document.createElement("button")
      rd.type = "button"
      rd.className = "md-icon-btn row-del"
      rd.textContent = "✕"
      rd.title = "删除该行"
      rd.onclick = () => { grid.splice(ri, 1); if (grid.length === 0) grid.push([null]); renderGrid() }
      rowEl.appendChild(rd)
      gridEl.appendChild(rowEl)
    })
    addRowBtn.disabled = grid.length >= MD_MAX_ROWS
    limit.textContent = `行 ${grid.length}/${MD_MAX_ROWS} · 单行列上限 ${MD_MAX_COLS}`
  }

  addRowBtn.onclick = () => { if (grid.length >= MD_MAX_ROWS) { mdToast(`最多 ${MD_MAX_ROWS} 行`); return } grid.push([null]); renderGrid() }

  wrap._getButtons = () => {
    const out = []
    for (const row of grid) {
      const r = row.filter(c => c != null)
      if (r.length) out.push(r)
    }
    return out
  }
  wrap._grid = grid
  wrap._rerender = renderGrid

  wrap.append(gridHead, gridEl, bottom)
  host.appendChild(wrap)
  mdBtnGridWrap = wrap
  renderGrid()
}

// Bot 发送消息后增量刷新（只追加新消息，无需清空 DOM 避免闪烁）
async function refreshAfterBotSend(chatId, auditId) {
  // 等待消息入 Redis
  await new Promise(r => setTimeout(r, 800))

  // 防止在此期间切换了聊天
  const currentChatId = state.chatType === "group" ? state.currentGroupId : state.currentPrivateUserId
  if (chatId !== currentChatId) return

  try {
    const prefix = state.chatType === "group" ? "group" : "private"
    const url = `/bot/${state.currentBotId}/${prefix}/${chatId}/messages?limit=10`
    const latestMessages = await api(url)

    const container = $("#chatMessages")
    if (!container) return

    // 收集所有现有 DOM 消息的标识（用于批量去重，避免回调等无 msg_idx 的消息重复）
    const domIds = new Set()
    container.querySelectorAll(".msg-item").forEach(el => {
      if (el.dataset.msgIdx) domIds.add("idx:" + el.dataset.msgIdx)
      if (el.dataset.auditId) domIds.add("audit:" + el.dataset.auditId)
      if (el.dataset.messageId) domIds.add("mid:" + el.dataset.messageId)
      // 时间戳+用户ID 作为兜底标识
      const ts = el.dataset.timestamp
      const uid = el.dataset.userId
      if (ts && uid) domIds.add("ts:" + ts + ":" + uid)
    })

    let hasNew = false
    for (const m of latestMessages) {
      // 多级去重：msg_idx → audit_id → message_id → timestamp+user_id
      let exists = false
      if (m.msg_idx && domIds.has("idx:" + m.msg_idx)) exists = true
      if (!exists && m.audit_id && domIds.has("audit:" + m.audit_id)) exists = true
      if (!exists && m.message_id && domIds.has("mid:" + m.message_id)) exists = true
      if (!exists && m.timestamp && m.user_id && domIds.has("ts:" + m.timestamp + ":" + m.user_id)) exists = true

      if (exists) {
        // 已存在：仅更新审核状态标记
        if (m.need_audit && m.audit_status) {
          updateAuditBadgeInDom(m.audit_id, m.audit_status, m.message_id)
        }
        continue
      }
      // 新消息：追加到 DOM
      appendWsMessage(m)
      hasNew = true
    }

    if (hasNew) scrollToBottom()

    // 审核消息：持续轮询审核状态（仅群聊支持审核）
    if (auditId && state.chatType === "group") pollAuditStatus(auditId, chatId)
  } catch (err) {
    console.error("[refreshAfterBotSend] 失败:", err)
  }
}

// 轮询审核状态
async function pollAuditStatus(auditId, groupId, attempt = 0) {
  const maxAttempts = 10
  const delays = [600, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 8000]

  if (attempt >= maxAttempts) return

  const delay = delays[attempt] || 8000
  await new Promise(r => setTimeout(r, delay))

  if (groupId !== state.currentGroupId) return

  try {
    const res = await api(`/bot/${state.currentBotId}/group/${groupId}/audit-check/${auditId}`)
    if (res.audit_status && res.audit_status !== "pending") {
      // 审核完成了，更新 DOM
      updateAuditBadgeInDom(auditId, res.audit_status, res.message_id || null)
      return
    }
    // 继续轮询
    pollAuditStatus(auditId, groupId, attempt + 1)
  } catch {
    pollAuditStatus(auditId, groupId, attempt + 1)
  }
}

// 更新 DOM 中指定 audit_id 消息的审核标记
function updateAuditBadgeInDom(auditId, auditStatus, messageId) {
  if (!auditId) return
  const el = document.querySelector(`.msg-item[data-audit-id="${auditId}"]`)
  if (!el) return

  // 搜索所有可能的审核标记位置：气泡行、附件区、视频控件区
  const body = el.querySelector(".msg-body")
  if (!body) return

  // 移除所有旧标记
  body.querySelectorAll(".msg-audit-badge").forEach(b => b.remove())

  // 插入新标记到合适位置
  const statusMap = {
    passed: `<span class="msg-audit-badge audit-passed">审核通过</span>`,
    rejected: `<span class="msg-audit-badge audit-rejected">审核拒绝</span>`,
  }
  const badgeHtml = statusMap[auditStatus] || `<span class="msg-audit-badge audit-pending">审核中</span>`

  const bubbleRow = body.querySelector(".msg-bubble-row")
  const attachBadges = body.querySelector(".msg-attach-badges")
  const videoBadges = body.querySelectorAll(".msg-video-badges-outside")

  if (bubbleRow) {
    // 有气泡行：直接追加到气泡行末尾
    bubbleRow.insertAdjacentHTML("beforeend", badgeHtml)
  } else if (videoBadges.length > 0) {
    // 视频卡片已自带 badges 容器，更新其内容
    videoBadges.forEach(vb => { vb.innerHTML = badgeHtml })
  } else if (attachBadges) {
    // 附件区有 badges 容器
    attachBadges.innerHTML = badgeHtml
  } else {
    // 创建新的 badges 容器
    body.insertAdjacentHTML("beforeend", `<div class="msg-attach-badges">${badgeHtml}</div>`)
  }

  // 审核通过后更新 message_id
  if (messageId) el.dataset.messageId = messageId
}

// ===== WebSocket 实时推送 =====
function connectWebSocket() {
  if (state.ws) return
  try {
    const proto = location.protocol === "https:" ? "wss" : "ws"
    const wsBase = WEB_BASE.substring(1) // "qqbot-web"
    state.ws = new WebSocket(`${proto}://${location.host}/${wsBase}-ws`)

    state.ws.onopen = () => {
      state.wsReady = true
      console.log("[WS] 已连接")
      // 重新订阅当前聊天
      const chatId = state.chatType === "group" ? state.currentGroupId : state.currentPrivateUserId
      if (state.currentBotId && chatId) {
        const msg = { type: "watch", selfId: state.currentBotId }
        if (state.chatType === "group") {
          msg.groupId = chatId
        } else {
          msg.privateUserId = chatId
        }
        state.ws.send(JSON.stringify(msg))
      }
    }

    state.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === "auth_error") {
          console.warn("[WS] 鉴权失败:", data.error)
          window.location.replace(`${WEB_BASE}/login.html`)
          return
        }
        handleWsMessage(data)
      } catch {}
    }

    state.ws.onclose = () => {
      state.wsReady = false
      state.ws = null
      console.log("[WS] 断开，3s后重连")
      setTimeout(connectWebSocket, 3000)
    }

    state.ws.onerror = () => {}
  } catch (err) {
    console.error("[WS] 连接失败:", err)
    setTimeout(connectWebSocket, 5000)
  }
}

// 群名更新（来自后端 getGroupInfo 补取/刷新）：更新本地 state 并刷新显示
function handleGroupNameUpdated(groupId, groupName) {
  if (!groupId || !groupName) return
  // 更新群列表数据
  const g = state.groups.find(x => x.group_id === groupId)
  if (g) g.group_name = groupName
  // 若当前打开的正是该群，同步聊天头部
  if (state.currentGroup && state.currentGroup.group_id === groupId) {
    state.currentGroup.group_name = groupName
    const nameEl = $("#chatHeaderName")
    if (nameEl) {
      const note = state.groupNotes[groupId] || ""
      nameEl.textContent = note || groupName
    }
  }
  // 刷新侧边栏群列表（含搜索过滤/置顶顺序不变）
  renderGroupList()
}

function handleWsMessage(data) {
  if (!data) return
  // 群名自动补取/刷新成功后，后端推送更新：立即刷新 Web 显示（不限于当前会话）
  if (data.type === "group_name_updated") {
    handleGroupNameUpdated(data.groupId, data.group_name)
    return
  }
  // 根据 chatType 和消息类型判断是否属于当前会话
  const currentChatId = state.chatType === "group" ? state.currentGroupId : state.currentPrivateUserId
  const msgChatId = data.groupId || data.privateUserId
  if (!msgChatId || String(msgChatId) !== String(currentChatId || "")) return

  switch (data.type) {
    case "new_message":
    case "new_private_message":
      // 新消息来了，追加到聊天区
      appendWsMessage(data.message)
      break
    case "bot_message_sent":
      // Bot 自己发出的消息，增量追加避免全量刷新闪烁
      if (data.audit_id && data.message_type) {
        _botSentMsgTypes[data.audit_id] = data.message_type
      }
      refreshAfterBotSend(msgChatId, data.audit_id)
      break
    case "message_recalled":
      // 消息撤回
      markRecalledInDom(data.message_id, data.audit_id)
      break
    case "message_deleted":
      // 消息从数据库删除
      if (data.msg_idx) {
        const container = $("#chatMessages")
        const el = container.querySelector(`.msg-item[data-msg-idx="${CSS.escape(data.msg_idx)}"]`)
        if (el) el.remove()
      }
      break
  }
}

function appendWsMessage(m) {
  const container = $("#chatMessages")
  if (!container) return

  // 多级去重：msg_idx → audit_id → message_id → timestamp+user_id
  const checkExists = (sel, val) => val && container.querySelector(`.msg-item[${sel}="${val}"]`)
  if (checkExists("data-msg-idx", m.msg_idx) ||
      checkExists("data-audit-id", m.audit_id) ||
      checkExists("data-message-id", m.message_id) ||
      (m.timestamp && m.user_id && checkExists("data-timestamp", m.timestamp)?.dataset?.userId === String(m.user_id))) {
    return
  }

  // 把新消息追加到 state.messages 末尾（升序排列，新消息在最后）
  state.messages.push(m)

  // 通知事件：以灰色胶囊样式显示
  if (m.is_notice) {
    const div = document.createElement("div")
    div.className = "msg-item msg-notice"
    div.dataset.timestamp = m.timestamp || ""
    div.dataset.userId = m.user_id || ""
    div.dataset.eventId = m.event_id || ""
    const avatarSrc = m.avatar || ""
    const noticeText = getNoticeText(m)
    const time = formatTime(m.timestamp)
    div.innerHTML = `
      <div class="msg-notice-pill">
        <span class="msg-notice-time">${time}</span>
        <div class="msg-notice-body">
          <img class="msg-notice-avatar" src="${avatarSrc}" alt="" onerror="this.style.display='none'">
          <span class="msg-notice-text">${noticeText}</span>
        </div>
      </div>
    `
    div.addEventListener("contextmenu", (e) => {
      e.preventDefault()
      showContextMenu(e, m)
    })
    addLongPress(div, (e) => showContextMenu(e, m))
    const wasAtBottom = isAtBottom()
    container.appendChild(div)
    if (wasAtBottom) {
      scrollToBottom()
      state.unreadCount = 0
      updateFloatGroup()
    } else {
      state.unreadCount++
      if (!state.firstUnreadEl) state.firstUnreadEl = div
      updateFloatGroup()
    }
    return
  }

  // 手动构建一个消息元素
  const isSelf = m.me
  const isBot = m.me || m.is_bot
  const div = document.createElement("div")
  div.className = `msg-item ${isSelf ? "msg-self" : ""} ${!isSelf && m.is_bot ? "is-bot" : ""}`
  div.dataset.msgIdx = m.msg_idx || ""
  div.dataset.messageId = m.message_id || ""
  div.dataset.auditId = m.audit_id || ""
  div.dataset.eventId = m.event_id || ""
  div.dataset.needAudit = m.need_audit ? "true" : "false"
  div.dataset.timestamp = m.timestamp || ""
  div.dataset.userId = m.user_id || ""

  const avatarSrc = m.avatar || ""
  const nickname = escHtml(m.nickname || m.user_id || "未知")
  const time = formatTime(m.timestamp)
  const roleBadge = getRoleBadgeHtml(m.sender?.role)
  const botMark = isBot ? ' <span style="font-size:10px;color:var(--success)">[Bot]</span>' : ""

  // 转发消息（聊天记录）特殊处理：渲染折叠卡片
  if (isForwardMessage(m)) {
    container.appendChild(buildForwardCard(m))
    const wasAtBottom = isAtBottom()
    if (wasAtBottom) {
      scrollToBottom()
      state.unreadCount = 0
      updateFloatGroup()
    } else {
      state.unreadCount++
      if (!state.firstUnreadEl) state.firstUnreadEl = null
      updateFloatGroup()
    }
    return
  }

  // 内容渲染（复用共享函数，支持图片/视频/音频/文件/附件）
  const { messageContent, attachmentHtml, badges, refSummary } = renderMessageContent(m)
  const hasText = !!messageContent

  // 引用条（实时消息可能还没有 ref_summary，需异步查询）
  let refBarHtml = ""
  if (refSummary) {
    const isFallback = refSummary.source === "fallback"
    const refNick = escHtml(refSummary.nickname || "未知")
    const refText = escHtml((refSummary.summary || "").slice(0, 50))
    const refClass = isFallback ? "msg-ref-bar msg-ref-bar-fallback" : "msg-ref-bar"
    const onClick = isFallback ? "" : `onclick="scrollToRefMsg(this)"`
    const title = isFallback ? "无法定位到原始消息（从事件中提取的引用内容）" : "点击跳转到被引用消息"
    // 降级引用中渲染附件缩略图
    let thumbHtml = ""
    if (isFallback && Array.isArray(refSummary.fallback_attachments) && refSummary.fallback_attachments.length) {
      for (const att of refSummary.fallback_attachments) {
        if (att.url) {
          thumbHtml += `<img class="msg-ref-thumb" src="${escHtml(att.url)}" alt="" onerror="this.style.display='none'">`
        }
      }
    }
    refBarHtml = `<div class="${refClass}" data-ref-idx="${escHtml(refSummary.msg_idx || m.ref_msg_idx || "")}" ${onClick} title="${title}">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" style="flex-shrink:0;margin-right:4px;"><path d="M2 7l3-4M2 7l3 4M2 7h10"/></svg>
      <span class="msg-ref-nick">${refNick}</span>
      <span class="msg-ref-text">${refText}</span>
      ${thumbHtml}
    </div>`
  }

  // 有文本时才显示气泡，引用条放在气泡内部（像QQ一样）
  const bubbleRowHtml = hasText
    ? `<div class="msg-bubble-row">
         <div class="msg-bubble">${refBarHtml}${messageContent}</div>
         ${badges}
       </div>`
    : (refBarHtml
        ? `<div class="msg-bubble-row">
             <div class="msg-bubble" style="padding:6px 10px;">${refBarHtml}</div>
           </div>`
        : "")

  // 无文本时把 badges 放到附件左侧下方（水平行：badges 在左，附件在右，底部对齐）
  let finalAttachmentHtml = attachmentHtml
  if (!hasText && badges && !attachmentHtml.includes("msg-video-badges-outside")) {
    if (isSelf && attachmentHtml) {
      finalAttachmentHtml = `<div class="msg-attach-row"><div class="msg-attach-badges">${badges}</div>${attachmentHtml}</div>`
    } else if (!isSelf && attachmentHtml) {
      finalAttachmentHtml = attachmentHtml + `<div class="msg-attach-badges">${badges}</div>`
    } else {
      finalAttachmentHtml = `<div class="msg-attach-badges">${badges}</div>`
    }
  }

  div.innerHTML = `
    <img class="msg-avatar" src="${avatarSrc}" alt="" onerror="this.style.display='none'">
    <div class="msg-body">
      <div class="msg-sender">${nickname}${roleBadge} <span class="msg-time-inline">${time}</span>${botMark}</div>
      ${bubbleRowHtml}
      ${finalAttachmentHtml}
      ${m.msg_idx ? `<div class="msg-idx">idx: ${m.msg_idx}</div>` : ""}
    </div>
  `

  renderKatex(div)
  highlightCode(div)

  div.addEventListener("contextmenu", (e) => {
    e.preventDefault()
    showContextMenu(e, m)
  })

  addLongPress(div, (e) => showContextMenu(e, m))

  // 点击头像 → 用户信息弹窗
  const avatarImg = div.querySelector(".msg-avatar")
  if (avatarImg) {
    avatarImg.addEventListener("click", (e) => {
      e.stopPropagation()
      showUserInfoModal(m, "chat")
    })
  }
  const wasAtBottom = isAtBottom()

  container.appendChild(div)

  if (wasAtBottom) {
    scrollToBottom()
    // 在底部时清除未读
    state.unreadCount = 0
    updateFloatGroup()
  } else {
    // 不在底部：累加未读计数
    state.unreadCount++
    // 记录第一条未读消息的 DOM 元素
    if (!state.firstUnreadEl) {
      state.firstUnreadEl = div
    }
    updateFloatGroup()
  }
}

function markRecalledInDom(message_id, audit_id) {
  const container = $("#chatMessages")
  if (!container) return
  let el = null
  if (message_id) el = container.querySelector(`.msg-item[data-message-id="${message_id}"]`)
  if (!el && audit_id) el = container.querySelector(`.msg-item[data-audit-id="${audit_id}"]`)
  if (!el) return

  el.classList.add("msg-recalled")
  // 替换或追加"已撤回"提示
  const body = el.querySelector(".msg-body")
  if (body) {
    const existingTip = body.querySelector(".msg-recalled-tip")
    if (!existingTip) {
      const tip = document.createElement("div")
      tip.className = "msg-recalled-tip"
      tip.textContent = "已撤回"
      body.appendChild(tip)
    }
    // 隐藏审核标记
    const badge = body.querySelector(".msg-audit-badge")
    if (badge) badge.remove()
  }
}

// ===== 富媒体发送（先上传获得 URL，再发送，避免大文件 base64 栈溢出） =====

async function sendMediaFile(file) {
  const chatId = state.chatType === "group" ? state.currentGroupId : state.currentPrivateUserId
  if (!state.currentBotId || !chatId) return

  // 根据 MIME 类型 + 扩展名确定 segment 类型
  const mime = (file.type || "").toLowerCase()
  const name = (file.name || "").toLowerCase()
  const videoExts = new Set(["mp4", "avi", "mkv", "mov", "wmv", "flv", "webm", "m4v", "3gp", "ts", "mpeg", "mpg"])
  const audioExts = new Set(["mp3", "wav", "flac", "aac", "ogg", "wma", "m4a", "opus", "ape", "aiff", "amr", "silk"])
  const imageExts = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico", "tiff", "tif"])

  const ext = name.includes(".") ? name.split(".").pop() : ""

  let segType
  if (mime.startsWith("image/") || imageExts.has(ext)) {
    segType = "image"
  } else if (mime.startsWith("video/") || videoExts.has(ext)) {
    segType = "video"
  } else if (mime.startsWith("audio/") || audioExts.has(ext)) {
    segType = "record"
  } else {
    segType = "file"
  }

  try {
    // 直接走二进制协议：segments 占位，Blob 数据随后
    const jsonPayload = {
      segments: [{ type: segType, file: "{img:0}", fileName: file.name }],
    }
    if (state.replyTo) jsonPayload.reply_msg_idx = state.replyTo.msg_idx
    if (state.replyEventId) jsonPayload.reply_event_id = state.replyEventId.event_id
    else if (state.replyMsgId) jsonPayload.reply_msg_id = state.replyMsgId.message_id
    else if (state.useReplyMsgId && state.messages.length > 0) {
      let latestOther = null
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i]
        if (!m.me && m.message_id) { latestOther = m; break }
      }
      if (latestOther) jsonPayload.reply_msg_id = latestOther.message_id
    }

    const jsonBytes = new TextEncoder().encode(JSON.stringify(jsonPayload))
    const parts = []
    const jsonLenBuf = new ArrayBuffer(4)
    new DataView(jsonLenBuf).setUint32(0, jsonBytes.length, true)
    parts.push(jsonLenBuf)
    parts.push(jsonBytes)
    const blobCountBuf = new ArrayBuffer(4)
    new DataView(blobCountBuf).setUint32(0, 1, true)
    parts.push(blobCountBuf)
    const blobLenBuf = new ArrayBuffer(4)
    new DataView(blobLenBuf).setUint32(0, file.size, true)
    parts.push(blobLenBuf)
    parts.push(file)

    const body = new Blob(parts, { type: "application/x-qqbot-bin" })

    const prefix = state.chatType === "group" ? "group" : "private"
    const sendRes = await api(`/bot/${state.currentBotId}/${prefix}/${chatId}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-qqbot-bin",
        "X-Bin-Protocol": "1",
        "X-Msg-Type": "media",
      },
      body,
    })

    // 检查业务层错误
    if (sendRes.success === false) {
      throw new Error(sendRes.error || "发送失败")
    }

    // 发送成功后清除引用状态
    if (state.replyTo) {
      state.replyTo = null
      updateReplyPreview()
    }
    state.replyMsgId = null
    state.replyEventId = null
    updateMsgIdReplyPreview()
    updateEventIdReplyPreview()

    refreshAfterBotSend(chatId, sendRes?.audit_id || null)
  } catch (err) {
    console.error("发送媒体文件失败:", err)
    alert("发送失败: " + err.message)
  }
}

// ===== Ark 消息 =====
function updateArkFields() {
  const sel = $("#arkTemplateSelect")
  if (!sel) return
  const tpl = sel.value
  $$(".ark-fields").forEach(el => { el.style.display = "none" })
  const panel = $(`#arkFields${tpl}`)
  if (panel) panel.style.display = ""
}

function addArkListItem(desc, link) {
  const container = $("#arkListItems")
  if (!container) return
  const row = document.createElement("div")
  row.className = "ark-list-item"
  row.innerHTML = `
    <span class="input-with-clear"><input placeholder="文本" value="${escHtml(desc || '')}"><button class="input-clear-btn" title="清空">&times;</button></span>
    <span class="input-with-clear"><input placeholder="链接（可选）" value="${escHtml(link || '')}"><button class="input-clear-btn" title="清空">&times;</button></span>
    <button class="ark-del-item" title="删除此行">✕</button>`
  row.querySelector(".ark-del-item").addEventListener("click", () => row.remove())
  container.appendChild(row)
}

/** 为单个 input 包裹清除按钮 */
function wrapInputWithClear(input) {
  if (input.parentElement && input.parentElement.classList.contains("input-with-clear")) return
  const wrapper = document.createElement("span")
  wrapper.className = "input-with-clear"
  input.parentNode.insertBefore(wrapper, input)
  wrapper.appendChild(input)
  const btn = document.createElement("button")
  btn.className = "input-clear-btn"
  btn.innerHTML = "&times;"
  btn.title = "清空"
  wrapper.appendChild(btn)
}

/** 为 Ark 表单的所有输入框包裹清除按钮 */
function wrapAllArkInputs() {
  $$("#arkForm .ark-fields .ark-form-row > input").forEach(wrapInputWithClear)
}

function clearArkForm() {
  // 清空所有 Ark 表单输入框
  $$("#arkForm input:not([type='hidden'])").forEach(el => { el.value = "" })
  // 清空列表编辑器条目
  const listItems = $("#arkListItems")
  if (listItems) listItems.innerHTML = ""
  // 重新添加初始空条目
  addArkListItem()
  addArkListItem()
  addArkListItem()
}

function buildArkSegment() {
  const sel = $("#arkTemplateSelect")
  if (!sel) return null
  const tpl = sel.value
  const gid = (id) => document.getElementById(id)?.value || ""

  if (tpl === "23") {
    const kv = [
      { key: "#DESC#", value: gid("ark23_desc") },
      { key: "#PROMPT#", value: gid("ark23_prompt") },
    ]
    const items = $$("#arkListItems .ark-list-item")
    if (items.length) {
      const list = items.map(row => {
        const ins = row.querySelectorAll("input")
        const obj = [{ key: "desc", value: ins[0]?.value || "" }]
        if (ins[1]?.value) obj.push({ key: "link", value: ins[1].value })
        return { obj_kv: obj }
      }).filter(o => o.obj_kv[0].value)
      if (list.length) kv.push({ key: "#LIST#", obj: list })
    }
    return { type: "ark", template_id: 23, kv }
  }

  if (tpl === "24") {
    return { type: "ark", template_id: 24, kv: [
      { key: "#DESC#", value: gid("ark24_desc") },
      { key: "#PROMPT#", value: gid("ark24_prompt") },
      { key: "#TITLE#", value: gid("ark24_title") },
      { key: "#METADESC#", value: gid("ark24_metadesc") },
      { key: "#IMG#", value: gid("ark24_img") },
      { key: "#LINK#", value: gid("ark24_link") },
      { key: "#SUBTITLE#", value: gid("ark24_subtitle") },
    ]}
  }

  if (tpl === "37") {
    const kv = [
      { key: "#PROMPT#", value: gid("ark37_prompt") },
      { key: "#METATITLE#", value: gid("ark37_title") },
      { key: "#METASUBTITLE#", value: gid("ark37_subtitle") },
      { key: "#METACOVER#", value: gid("ark37_cover") },
    ]
    // #METAURL# 可选，且需域名报备，不填或未报备时省略
    const url = gid("ark37_url")
    if (url) kv.push({ key: "#METAURL#", value: url })
    return { type: "ark", template_id: 37, kv }
  }

  return null
}

// ===== 滚动加载更多 =====
function setupScrollHandler() {
  const container = $("#chatMessages")

  // 滚动事件：加载更多 + 更新浮动小球显隐
  container.addEventListener("scroll", () => {
    // 加载更多
    if (!state.isLoadingMore && state.hasMore && container.scrollTop <= 60) {
      loadMessages(null, true)
    }

    // 用户手动滚动到底部时清除未读计数
    if (isAtBottom() && state.unreadCount > 0) {
      state.unreadCount = 0
      state.firstUnreadEl = null
    }

    // 每次滚动都更新浮动小球（箭头 + 未读计数）
    updateFloatGroup()
  })

  // 点击未读小球：跳转到第一条未读消息
  const unreadBadge = $("#unreadBadge")
  if (unreadBadge) {
    unreadBadge.addEventListener("click", (e) => {
      e.stopPropagation()
      if (state.firstUnreadEl) {
        scrollMsgIntoView($("#chatMessages"), state.firstUnreadEl, "start")
      }
      state.unreadCount = 0
      state.firstUnreadEl = null
      updateFloatGroup()
    })
  }

  // 点击箭头小球：滚动到底部
  const arrowBadge = $("#scrollArrowBadge")
  if (arrowBadge) {
    arrowBadge.addEventListener("click", (e) => {
      e.stopPropagation()
      scrollToBottom()
      state.unreadCount = 0
      state.firstUnreadEl = null
      updateFloatGroup()
    })
  }
}

// ===== 事件绑定 =====
function setupEventListeners() {
  // 移动端：阻止浏览器原生长按菜单，统一由 addLongPress 自定义菜单处理
  document.addEventListener("contextmenu", (e) => {
    if (window.__longPressed) {
      e.preventDefault()
      window.__longPressed = false
      return
    }
    // 移动端：消息列表、群列表、私聊列表、聊天区内的图片/头像 → 阻止原生菜单
    if (isMobile() && (
      e.target.closest(".msg-item,.group-list-item,.private-chat-item") ||
      e.target.closest("#chatMessages img,#chatGroupList img")
    )) {
      e.preventDefault()
    }
  })

  // 移动端：拦截浏览器物理返回键，分层导航
  window.addEventListener("popstate", (e) => {
    if (!isMobile()) return
    // 程序化 history.go（离开拓展区时）触发的 popstate，直接忽略
    if (suppressPop > 0) { suppressPop--; return }

    const s = e.state
    // 拓展区内部返回：web page 有弹窗先关弹窗，否则回到拓展列表
    if (s && s.ext) {
      extDepth = Math.max(0, extDepth - 1)
      const sub = s.sub
      const sec = document.getElementById(`page-${sub}`)
      let modalOpen = false
      if (webPageModalState.has(sub)) modalOpen = true
      if (sec) {
        const dlg = sec.querySelector("dialog[open]")
        if (dlg) { dlg.close(); modalOpen = true }
      }
      if (modalOpen) {
        // 通知 iframe 关闭其弹窗，并重新压入守卫态以停留在本页
        const iframe = sec && sec.querySelector("iframe")
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage({ type: "webpage-close-modal" }, "*")
        }
        webPageModalState.delete(sub)
        history.pushState({ ext: true, sub, modal: true }, "", location.href)
        extDepth++
        return
      }
      webPageModalState.delete(sub)
      // 无弹窗可关闭 → 回到拓展列表（同一历史层，不堆叠）
      navigateTo("extensions", { push: false })
      return
    }

    // 离开拓展区 / 其它无状态返回 → 回到进入拓展区前的页面（或消息页）
    if (!s || (!s.mobileChat && !s.rawModal && !s.userInfo && !s.memberList && !s.forward)) {
      extDepth = 0
      navigateTo(extReturnPage || "messages", { push: false })
      return
    }

    if (!state.mobileChatActive) return

    // 1. rawModal 打开中 → 关闭弹窗
    if ($("#rawModal")?.style.display === "flex") {
      $("#rawModal").style.display = "none"
      return
    }

    // 2. 用户信息弹窗打开中 → 关闭弹窗，返回上一层
    if ($("#userInfoModal").style.display === "flex") {
      closeUserInfoModal()
      return
    }

    // 3. 群成员列表弹窗打开中 → 关闭弹窗，返回聊天
    if ($("#memberListModal")?.style.display === "flex") {
      closeMemberList()
      return
    }

    // 4. 转发消息（聊天记录）弹窗打开中 → 关闭弹窗，返回聊天
    if ($("#forwardModal")?.style.display === "flex") {
      closeForwardModal()
      return
    }

    // 5. 在聊天中 → 返回群/私聊列表
    if (!state.currentGroupId && !state.currentPrivateUserId) return
    // 阻止实际跳转，先 push 一个状态占位
    history.pushState({ mobileChat: true }, "", location.href)
    // 模拟返回按钮行为
    const chatBackBtn = $("#chatHeaderBack")
    if (chatBackBtn) chatBackBtn.click()
  })

  // 自定义页面（iframe）上报其弹窗打开/关闭状态，用于拦截返回键
  // 页面侧约定：弹窗打开/关闭时 postMessage({ type: "webpage-modal", open: true/false, id })
  window.addEventListener("message", (e) => {
    const d = e.data
    if (!d || d.type !== "webpage-modal" || typeof d.open !== "boolean") return
    const id = d.id || state.currentPage
    if (d.open) {
      webPageModalState.add(id)
      // 在当前页面顶部压入守卫态，使返回键优先关闭弹窗而非离开页面
      if (isMobile() && id === state.currentPage && extDepth > 0) {
        history.pushState({ ext: true, sub: id, modal: true }, "", location.href)
        extDepth++
      }
    } else {
      webPageModalState.delete(id)
    }
  })

  $("#botSelector").addEventListener("click", toggleBotDropdown)

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".bot-dropdown") && !e.target.closest("#botSelector")) {
      closeBotDropdown()
    }
  })

  // 点击消息内 @ 提及胶囊 → 在输入框插入 @
  document.addEventListener("click", (e) => {
    const capsule = e.target.closest(".msg-at-capsule")
    if (!capsule) return
    e.preventDefault()
    const uid = capsule.dataset.atUid || ""
    const nick = capsule.dataset.atNick || uid
    if (!uid) return
    // 确保输入框区域可见（移动端切换到聊天区）
    if (isMobile() && state.currentGroupId) {
      showMobileChat()
    }
    insertMention(uid, nick)
  })

  // 一键清空按钮（仅 Ark 模式显示，清空 Ark 表单）
  const chatClearBtn = $("#chatInputClear")
  if (chatClearBtn) {
    chatClearBtn.addEventListener("click", (e) => {
      e.preventDefault()
      e.stopPropagation()
      clearArkForm()
    })
  }

  // 聊天输入框内联 × 清除按钮（普通/MD 模式显示）
  const inlineClearBtn = $("#chatInputInlineClear")
  if (inlineClearBtn) {
    inlineClearBtn.addEventListener("click", (e) => {
      e.preventDefault()
      e.stopPropagation()
      const editor = $("#chatInput")
      editor.innerHTML = ""
      editor.focus()
      editor.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }

  // Ark 表单输入框 × 清除按钮（事件委托）
  document.addEventListener("click", (e) => {
    // 使用 closest?. 处理文本节点（文本节点上没有 closest 方法）
    const btn = (e.target instanceof Element ? e.target : e.target.parentElement)?.closest(".input-clear-btn")
    if (!btn) return
    e.preventDefault()
    e.stopPropagation()
    const wrapper = btn.closest(".input-with-clear")
    const input = wrapper?.querySelector("input")
    if (input) {
      input.value = ""
      input.focus()
      input.dispatchEvent(new Event("input", { bubbles: true }))
    }
  })

  // 导航（PC 侧边栏）
  $$(".nav-item").forEach(el => {
    el.addEventListener("click", (e) => {
      e.preventDefault()
      navigateTo(el.dataset.page)
    })
  })

  // 移动端底部导航
  $$(".mobile-nav-item").forEach(el => {
    el.addEventListener("click", () => {
      // 如果已经在当前页，不重复导航
      if (state.currentPage !== el.dataset.page) {
        navigateTo(el.dataset.page)
      }
    })
  })

  // 为 Ark 表单输入框添加 × 清除按钮
  wrapAllArkInputs()

  // 聊天头返回按钮（移动端）
  const chatBackBtn = $("#chatHeaderBack")
  if (chatBackBtn) {
    chatBackBtn.addEventListener("click", () => {
      const prevChatId = state.chatType === "group" ? state.currentGroupId : state.currentPrivateUserId
      state.currentGroupId = null
      state.currentGroup = null
      state.currentPrivateUserId = null
      state.currentPrivateUser = null
      state.messages = []
      stopAllMedia()
      showMobileGroupList()
      if (state.chatType === "group") {
        renderGroupList()
      } else {
        renderPrivateChatList()
      }
      refreshChatView()
      if (state.ws && state.wsReady && state.currentBotId) {
        if (prevChatId) {
          const msg = { type: "unwatch", selfId: state.currentBotId }
          if (state.chatType === "group") {
            msg.groupId = prevChatId || ""
          } else {
            msg.privateUserId = prevChatId || ""
          }
          state.ws.send(JSON.stringify(msg))
        }
      }
    })
  }

  // ===== 群信息按钮 & 成员列表弹窗 =====

  const memberListModal = $("#memberListModal")
  const memberListBody = $("#memberListBody")
  const memberListSearch = $("#memberListSearch")
  const memberListTitle = $("#memberListModalTitle")
  let allMembersCache = [] // 缓存当前群全部成员

  async function openMemberList() {
    if (!state.currentBotId || !state.currentGroupId) return
    memberListTitle.textContent = "群成员列表"
    memberListBody.innerHTML = '<div class="member-list-loading">加载中...</div>'
    memberListSearch.value = ""
    memberListModal.style.display = "flex"
    allMembersCache = []

    // 移动端：推入历史状态以支持返回键导航
    if (isMobile()) {
      history.pushState({ memberList: true }, "", location.href)
      state.mobileChatActive = true
    }

    try {
      const res = await api(
        `/bot/${state.currentBotId}/group/${state.currentGroupId}/members`
      )
      allMembersCache = res.members || []
      memberListTitle.textContent = `群成员 (${allMembersCache.length})`
      renderMemberList(allMembersCache)
    } catch {
      allMembersCache = []
      memberListTitle.textContent = "群成员"
      memberListBody.innerHTML = '<div class="member-list-loading">加载失败</div>'
    }
  }

  function renderMemberList(members) {
    if (!members.length) {
      memberListBody.innerHTML = '<div class="member-list-loading">暂无成员数据</div>'
      return
    }
    memberListBody.innerHTML = members.map(m => `
      <div class="member-row" data-user-id="${escHtml(m.user_id)}" data-nick="${escHtml(m.nickname)}">
        ${m.avatar ? `<img class="member-row-avatar" src="${escHtml(m.avatar)}" onerror="this.style.display='none'" loading="lazy">` : ""}
        <div class="member-row-info">
          <span class="member-row-nick">${escHtml(m.nickname)}</span>
          <span class="member-row-id">${escHtml(m.user_id)}</span>
        </div>
        <button class="member-row-at" title="在聊天中@此成员">@TA</button>
      </div>
    `).join("")

    // 点击行：打开用户信息（@TA按钮除外）
    memberListBody.querySelectorAll(".member-row").forEach(row => {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".member-row-at")) return // 由按钮处理
        const member = allMembersCache.find(m => m.user_id === row.dataset.userId)
        if (member) showUserInfoModal(member, "memberList")
      })
    })

    // @TA 按钮
    memberListBody.querySelectorAll(".member-row-at").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation()
        const row = btn.closest(".member-row")
        atMemberFromList(row.dataset.userId, row.dataset.nick)
      })
    })
  }

  function atMemberFromList(userId, nickname) {
    closeMemberList()
    if (isMobile() && state.currentGroupId) showMobileChat()
    insertMention(userId, nickname)
  }

  function closeMemberList() {
    memberListModal.style.display = "none"
  }

  // 群信息按钮
  const infoBtn = $("#chatHeaderInfoBtn")
  if (infoBtn) infoBtn.addEventListener("click", openMemberList)

  // 成员弹窗关闭按钮
  $("#memberListModalClose").addEventListener("click", () => {
    if (isMobile() && $("#memberListModal").style.display === "flex") history.back()
    else closeMemberList()
  })
  memberListModal.addEventListener("click", (e) => {
    if (e.target === memberListModal) {
      if (isMobile()) history.back()
      else closeMemberList()
    }
  })

  // 成员搜索
  memberListSearch.addEventListener("input", () => {
    const q = memberListSearch.value.trim().toLowerCase()
    if (!q) { renderMemberList(allMembersCache); return }
    renderMemberList(allMembersCache.filter(m => m.nickname.toLowerCase().includes(q)))
  })

  // 群搜索
  $("#groupSearch").addEventListener("input", () => {
    if (state.chatType === "private") {
      renderPrivateChatList()
    } else {
      renderGroupList()
    }
  })

  // 统一选择器：活跃群 / 全量群 / 私聊
  $$("#chatListSelector .chat-list-sel-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const newChatType = btn.dataset.chatType
      const newMode = btn.dataset.mode || ""

      // 同类型且同模式则忽略
      if (state.chatType === newChatType && state.groupMode === newMode) return

      const prevChatType = state.chatType
      state.chatType = newChatType
      state.groupMode = newMode || "active"
      state.currentGroupId = null
      state.currentGroup = null
      state.currentPrivateUserId = null
      state.currentPrivateUser = null
      state.messages = []
      state.replyTo = null
      stopAllMedia()

      // 全量群默认关闭 message_id 回复，活跃群/私聊默认开启
      state.useReplyMsgId = newChatType === "private" ? true : (newMode !== "quanliang")

      $$("#chatListSelector .chat-list-sel-item").forEach(b => b.classList.remove("active"))
      btn.classList.add("active")

      // 更新搜索框占位符
      const searchInput = $("#groupSearch")
      if (searchInput) searchInput.placeholder = newChatType === "private" ? "搜索私聊..." : "搜索群聊..."

      // 切换聊天类型时需要取消旧 WebSocket 订阅
      if (newChatType !== prevChatType || prevChatType === "group") {
        if (state.ws && state.wsReady && state.currentBotId) {
          const oldChatId = state.currentGroupId || state.currentPrivateUserId
          if (oldChatId) {
            const msg = { type: "unwatch", selfId: state.currentBotId }
            state.ws.send(JSON.stringify(msg))
          }
        }
      }

      refreshChatView()
      updateReplyPreview()
      updateMsgIdReplyPreview()

      if (state.currentBotId) {
        if (newChatType === "private") {
          loadPrivateChats()
        } else {
          loadGroups()
        }
      }
    })
  })

  // 消息类型切换
  $$(".msg-type-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".msg-type-btn").forEach(b => b.classList.remove("active"))
      btn.classList.add("active")
      state.messageType = btn.dataset.type

      const fileInput = $("#chatFileInput")
      const textInput = $("#chatInput")
      const textWrapper = $("#chatInputWrapper")
      const uploadBtn = $("#chatUploadBtn")
      const chatImageBtn = $("#chatImageBtn")
      const sendBtn = $("#chatSendBtn")
      const arkForm = $("#arkForm")
      const clearBtn = $("#chatInputClear")
      const inlineClearBtn = $("#chatInputInlineClear")
      const emojiTriggerNormal = $("#emojiTriggerNormal")
      const mdBtnBtn = $("#chatMdBtnBtn")

      if (btn.dataset.type === "media") {
        textInput.style.display = "none"
        if (textWrapper) textWrapper.style.display = "none"
        fileInput.style.display = "none"
        if (uploadBtn) uploadBtn.classList.add("show")
        if (chatImageBtn) chatImageBtn.style.display = "none"
        if (sendBtn) sendBtn.style.display = "none"
        if (arkForm) arkForm.style.display = "none"
        if (clearBtn) clearBtn.classList.remove("show")
        if (inlineClearBtn) inlineClearBtn.style.display = "none"
        if (emojiTriggerNormal) emojiTriggerNormal.style.display = "none"
        if (mdBtnBtn) mdBtnBtn.style.display = "none"
        mdHideInline()
      } else if (btn.dataset.type === "ark") {
        textInput.style.display = "none"
        if (textWrapper) textWrapper.style.display = "none"
        fileInput.style.display = "none"
        if (uploadBtn) uploadBtn.classList.remove("show")
        if (chatImageBtn) chatImageBtn.style.display = "none"
        if (sendBtn) sendBtn.style.display = ""
        if (arkForm) arkForm.style.display = ""
        if (clearBtn) clearBtn.classList.add("show")
        if (inlineClearBtn) inlineClearBtn.style.display = "none"
        if (emojiTriggerNormal) emojiTriggerNormal.style.display = "none"
        if (mdBtnBtn) mdBtnBtn.style.display = "none"
        mdHideInline()
        updateArkFields()
      } else {
        textInput.style.display = ""
        if (textWrapper) { textWrapper.style.display = "" }
        fileInput.style.display = "none"
        if (uploadBtn) uploadBtn.classList.remove("show")
        if (chatImageBtn) chatImageBtn.style.display = ""
        if (sendBtn) sendBtn.style.display = ""
        if (arkForm) arkForm.style.display = "none"
        if (clearBtn) clearBtn.classList.remove("show")
        if (inlineClearBtn) inlineClearBtn.style.display = ""
        if (emojiTriggerNormal) emojiTriggerNormal.style.display = ""
        if (mdBtnBtn) mdBtnBtn.style.display = (btn.dataset.type === "markdown") ? "" : "none"
        if (btn.dataset.type !== "markdown") mdHideInline()
      }
    })
  })

  // MD 消息按钮构造入口（点击图标内联展开 / 收起构造区）
  const mdBtnBtnEl = $("#chatMdBtnBtn")
  if (mdBtnBtnEl) {
    mdBtnBtnEl.addEventListener("click", () => {
      if ($("#mdBtnInline").style.display === "none") mdOpenBuilder()
      else mdCloseBuilder(true)
    })
  }
  const mdBtnInlineClose = $("#mdBtnInlineClose")
  if (mdBtnInlineClose) mdBtnInlineClose.onclick = () => mdCloseBuilder(true)
  const mdBtnClear = $("#mdBtnClear")
  if (mdBtnClear) mdBtnClear.onclick = () => { state.mdButtons = []; renderMdBtnGrid() }
  const mdBtnEditClose = $("#mdBtnEditClose")
  if (mdBtnEditClose) mdBtnEditClose.onclick = mdCloseBtnEdit
  const mdBtnEditCancel = $("#mdBtnEditCancel")
  if (mdBtnEditCancel) mdBtnEditCancel.onclick = mdCloseBtnEdit
  const mdBtnEditSave = $("#mdBtnEditSave")
  if (mdBtnEditSave) mdBtnEditSave.onclick = mdSaveBtn
  const mdBtnEditDel = $("#mdBtnEditDel")
  if (mdBtnEditDel) mdBtnEditDel.onclick = mdDelBtnFromGrid
  const mdBtnEditOverlay = $("#mdBtnEditOverlay")
  if (mdBtnEditOverlay) mdBtnEditOverlay.onclick = (e) => { if (e.target === mdBtnEditOverlay) mdCloseBtnEdit() }

  // 文件上传按钮（富媒体模式） → 触发 file input
  const uploadBtn = $("#chatUploadBtn")
  if (uploadBtn) {
    uploadBtn.addEventListener("click", () => {
      $("#chatFileInput").click()
    })
  }

  // 文件输入（富媒体模式）
  $("#chatFileInput").addEventListener("change", async (e) => {
    const files = e.target.files
    if (!files.length) return
    for (const file of files) {
      await sendMediaFile(file)
    }
    e.target.value = ""
  })

  // 图片上传 input（普通/MD 模式 & Ark 表单共用）
  const chatImageInput = $("#chatImageInput")

  // ===== 简单 Toast 提示 =====
  function showToast(msg) {
    const el = document.createElement("div")
    el.className = "toast-msg"
    el.textContent = msg
    document.body.appendChild(el)
    requestAnimationFrame(() => el.classList.add("show"))
    setTimeout(() => {
      el.classList.remove("show")
      setTimeout(() => el.remove(), 300)
    }, 2000)
  }

  // ===== 图片上传核心逻辑 =====
  function selectImageFile() {
    return new Promise((resolve) => {
      chatImageInput.value = ""
      chatImageInput.onchange = () => {
        resolve(chatImageInput.files[0] || null)
      }
      chatImageInput.click()
    })
  }

  async function doUploadImage(file) {
    if (!file || !state.currentBotId) return null
    // 直接上传 File/blob，避免大图片 base64 导致 JSON.stringify 栈溢出
    try {
      return await uploadFileForSend(file, file.name)
    } catch (err) {
      console.error("图片上传失败:", err)
      return null
    }
  }

  // 普通/MD 模式：读取文件为 base64 并插入光标位置
  async function uploadImageForChat() {
    const file = await selectImageFile()
    if (!file) return
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error("文件读取失败"))
        reader.readAsDataURL(file)
      })
      const ext = file.type.split("/")[1] || "png"
      const now = new Date()
      const pad = n => String(n).padStart(2, "0")
      const fileName = `upload_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`
      insertPastedImage(fileName, dataUrl, file)
      showToast("图片已插入")
    } catch (err) {
      console.error("图片插入失败:", err)
      showToast("插入失败: " + (err.message || "未知错误"))
    }
  }

  // 聊天图片按钮点击
  const chatImageBtn = $("#chatImageBtn")
  if (chatImageBtn) {
    chatImageBtn.addEventListener("click", uploadImageForChat)
  }

  // Ark 表单图片上传按钮（通过 data-target 指定目标 input id）
  async function uploadImageForArk(targetId) {
    const file = await selectImageFile()
    if (!file) return
    showToast("图片上传中...")
    try {
      const url = await doUploadImage(file)
      if (!url) { showToast("上传失败"); return }
      const input = $(`#${targetId}`)
      if (input) {
        input.value = url
        input.dispatchEvent(new Event("input", { bubbles: true }))
        showToast("链接已填入")
      }
    } catch (err) {
      console.error("图片上传失败:", err)
      showToast("上传失败: " + (err.message || "未知错误"))
    }
  }

  $$(".ark-upload-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.target
      if (targetId) uploadImageForArk(targetId)
    })
  })

  // 表情包按钮（普通/MD 触发、Ark 24/37 上传旁）
  const emojiTriggerNormal = $("#emojiTriggerNormal")
  if (emojiTriggerNormal) emojiTriggerNormal.addEventListener("click", () => openEmojiPicker({ mode: "editor" }))
  $$(".ark-emoji-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      openEmojiPicker({ mode: "ark", target: btn.dataset.target })
    })
  })

  // 保存光标位置（失焦时），用于 insertMention 恢复
  $("#chatInput").addEventListener("blur", () => {
    const sel = window.getSelection()
    if (sel.rangeCount > 0) {
      savedEditorRange = sel.getRangeAt(0).cloneRange()
    }
  })

  // 编辑器内点击/选中等操作时清除已保存的 range（表示用户有新的操作）
  $("#chatInput").addEventListener("mouseup", () => { savedEditorRange = null })
  $("#chatInput").addEventListener("keyup", () => { savedEditorRange = null })

  // 发送按钮
  $("#chatSendBtn").addEventListener("click", sendMessage)

  // Ark 模板切换 → 更新表单字段
  const arkTemplateSelect = $("#arkTemplateSelect")
  if (arkTemplateSelect) {
    arkTemplateSelect.addEventListener("change", () => {
      updateArkFields()
    })
  }

  // Ark 添加列表条目按钮
  const arkAddItemBtn = $("#arkAddItem")
  if (arkAddItemBtn) {
    arkAddItemBtn.addEventListener("click", () => addArkListItem())
  }

  // 初始添加几个空条目
  addArkListItem()
  addArkListItem()
  addArkListItem()

  // ===== @成员选择器 =====

  // 创建弹窗 DOM（挂载到 body 避免被 overflow:hidden 裁剪）
  const atPopup = document.createElement("div")
  atPopup.className = "at-mention-popup"
  atPopup.id = "atMentionPopup"
  document.body.appendChild(atPopup)

  // @ 弹窗状态
  const atState = {
    active: false,
    members: [],
    activeIndex: 0,
    mentionRange: null,   // @ 符号起始位置的 Range（用于替换文本）
    fetchTimer: null,
  }

  /** 请求成员列表并打开弹窗 */
  async function openAtPopup(query) {
    atState.active = true
    atState.activeIndex = 0

    // 动态定位：底部锚定输入行上方（QQ 风格：下方固定，上方随人数缩短）
    const inputRow = document.querySelector(".chat-input-row")
    if (inputRow) {
      const rect = inputRow.getBoundingClientRect()
      const gap = 8
      atPopup.style.top = 'auto'
      atPopup.style.bottom = `${window.innerHeight - rect.top + gap}px`
      atPopup.style.left = `${rect.left}px`
      atPopup.style.width = `${rect.width}px`
      atPopup.style.maxHeight = `${Math.min(260, rect.top - gap * 2)}px`
    }
    atPopup.classList.add("show")

    if (state.chatType !== "group") { closeAtPopup(); return }

    const chatId = state.currentGroupId
    if (!chatId) { closeAtPopup(); return }

    try {
      const res = await api(
        `/bot/${state.currentBotId}/group/${chatId}/members?q=${encodeURIComponent(query)}`
      )
      atState.members = res.members || []
    } catch {
      atState.members = []
    }
    renderAtPopup()
  }

  function closeAtPopup() {
    atState.active = false
    atState.members = []
    atState.activeIndex = 0
    atState.mentionRange = null
    clearTimeout(atState.fetchTimer)
    atPopup.classList.remove("show")
  }

  function renderAtPopup() {
    const list = atState.members
    if (list.length === 0) {
      atPopup.innerHTML = `<div class="at-mention-item" style="color:#888;cursor:default">无匹配成员</div>`
      return
    }
    atPopup.innerHTML = list.map((m, i) => `
      <div class="at-mention-item${i === atState.activeIndex ? " active" : ""}"
           data-user-id="${escHtml(m.user_id)}" data-nick="${escHtml(m.nickname)}">
        ${m.avatar ? `<img class="at-avatar" src="${escHtml(m.avatar)}" onerror="this.style.display='none'" loading="lazy">` : ""}
        <span class="at-nick">${escHtml(m.nickname)}</span>
        <span class="at-id">${escHtml(m.user_id)}</span>
      </div>
    `).join("")

    // 绑定 mousedown（preventDefault 防止点击时编辑器失焦）
    atPopup.querySelectorAll(".at-mention-item[data-user-id]").forEach(el => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault()
        selectAtMember(el.dataset.userId, el.dataset.nick)
      })
    })
  }

  function scrollAtActiveIntoView() {
    const activeEl = atPopup.querySelector(".at-mention-item.active")
    if (activeEl) activeEl.scrollIntoView({ block: "nearest" })
  }

  /** 选中成员：删掉 @xxx 文本，插入 mention-chip */
  function selectAtMember(userId, nickname) {
    const editor = $("#chatInput")

    // 删除 @xxx 文本（从 @ 位置到光标），并把选区定位到删除点
    const sel = window.getSelection()
    if (sel.rangeCount && atState.mentionRange) {
      const delRange = document.createRange()
      delRange.setStart(atState.mentionRange.startContainer, atState.mentionRange.startOffset)
      delRange.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset)
      delRange.deleteContents()
      // deleteContents 后 delRange 坍缩到删除点，手动恢复选区
      sel.removeAllRanges()
      sel.addRange(delRange)
    }

    closeAtPopup()

    // 调用已有的 insertMention 插入胶囊
    savedEditorRange = null
    editor.focus()
    insertMention(userId, nickname)
  }

  /** 键盘导航（由 keydown handler 调用） */
  function handleAtKeydown(e) {
    if (!atState.active) return false

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        atState.activeIndex = Math.min(atState.activeIndex + 1, atState.members.length - 1)
        renderAtPopup()
        scrollAtActiveIntoView()
        return true
      case "ArrowUp":
        e.preventDefault()
        atState.activeIndex = Math.max(atState.activeIndex - 1, 0)
        renderAtPopup()
        scrollAtActiveIntoView()
        return true
      case "Enter":
        if (atState.members.length > 0 && atState.activeIndex >= 0) {
          e.preventDefault()
          const m = atState.members[atState.activeIndex]
          selectAtMember(m.user_id, m.nickname)
          return true
        }
        break
      case "Escape":
        e.preventDefault()
        closeAtPopup()
        return true
    }
    return false
  }

  /** 检测编辑器内 @ 输入，打开/更新弹窗 */
  function checkAtInput() {
    if (state.chatType !== "group") { closeAtPopup(); return }

    const editor = $("#chatInput")
    const sel = window.getSelection()
    if (!sel.rangeCount || !editor.contains(sel.anchorNode)) { closeAtPopup(); return }

    const range = sel.getRangeAt(0)
    const node = range.startContainer
    const offset = range.startOffset

    // 找光标前最近的 @
    let text = ""
    let atIdx = -1
    if (node.nodeType === Node.TEXT_NODE) {
      text = node.textContent.slice(0, offset)
      atIdx = text.lastIndexOf("@")
    }

    if (atIdx < 0) { closeAtPopup(); return }

    const query = text.slice(atIdx + 1)
    // 含空格/换行/过长 → 不触发
    if (query.includes(" ") || query.includes("\n") || query.length > 50) {
      closeAtPopup()
      return
    }

    // 保存 @ 位置（用于后续替换）
    const backup = document.createRange()
    backup.setStart(node, atIdx)
    backup.collapse(true)
    atState.mentionRange = backup

    // 防抖搜索
    clearTimeout(atState.fetchTimer)
    atState.fetchTimer = setTimeout(() => openAtPopup(query), atState.active ? 80 : 0)
  }

  // 回车发送 / Shift+Enter 换行 / @ 弹窗导航
  $("#chatInput").addEventListener("keydown", (e) => {
    // 先给 @ 弹窗处理（Arrow/slash/Enter/Escape）
    if (handleAtKeydown(e)) return
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  })

  // 删除选中内容中的胶囊时一并移除
  $("#chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Backspace" || e.key === "Delete") {
      const sel = window.getSelection()
      if (!sel.rangeCount) return
      const range = sel.getRangeAt(0)
      if (!range.collapsed) return // 有选中内容，交给浏览器处理

      const editor = $("#chatInput")
      if (e.key === "Backspace") {
        // 光标紧跟在胶囊后面 → 删除整个胶囊
        const node = range.startContainer
        const prev = node.previousSibling
        if (prev && prev.classList && prev.classList.contains("mention-chip") && range.startOffset === 0) {
          e.preventDefault()
          prev.remove()
          editor.dispatchEvent(new Event("input", { bubbles: true }))
        }
      } else if (e.key === "Delete") {
        // 光标紧贴在胶囊前面 → 删除整个胶囊
        const node = range.startContainer
        const next = node.nextSibling
        if (next && next.classList && next.classList.contains("mention-chip") &&
            (node.nodeType === Node.TEXT_NODE ? range.startOffset === node.textContent.length : true)) {
          e.preventDefault()
          next.remove()
          editor.dispatchEvent(new Event("input", { bubbles: true }))
        }
      }
    }
  })

  // @ 成员选择器：监听输入，检测 @ 并弹出成员列表
  $("#chatInput").addEventListener("input", checkAtInput)

  // 点击胶囊上的 X 删除按钮 / 粘贴图片的删除按钮
  $("#chatInput").addEventListener("click", (e) => {
    if (e.target.classList.contains("mention-chip-x")) {
      e.preventDefault()
      e.stopPropagation()
      const chip = e.target.closest(".mention-chip")
      if (chip) {
        chip.remove()
        $("#chatInput").dispatchEvent(new Event("input", { bubbles: true }))
        $("#chatInput").focus()
      }
    } else if (e.target.classList.contains("pasted-img-remove")) {
      e.preventDefault()
      e.stopPropagation()
      const wrapper = e.target.closest(".pasted-img-wrapper")
      if (wrapper) {
        wrapper.remove()
        $("#chatInput").dispatchEvent(new Event("input", { bubbles: true }))
        $("#chatInput").focus()
      }
    }
  })

  // 粘贴图片
  $("#chatInput").addEventListener("paste", handleEditorPaste)

  // 右键菜单
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#contextMenu")) {
      hideContextMenu()
    }
    if (!e.target.closest("#groupContextMenu")) {
      hideGroupContextMenu()
    }
    if (!e.target.closest("#privateUserContextMenu")) {
      hidePrivateUserContextMenu()
    }
  })

  $("#contextMenu").addEventListener("click", (e) => {
    const action = e.target.closest(".context-menu-item")?.dataset.action
    if (action) {
      handleContextAction(action)
      hideContextMenu()
    }
  })

  // 群右键菜单
  $("#groupContextMenu").addEventListener("click", (e) => {
    const action = e.target.closest(".context-menu-item")?.dataset.action
    if (action) {
      handleGroupContextAction(action)
      hideGroupContextMenu()
    }
  })

  // 私聊用户右键菜单
  $("#privateUserContextMenu").addEventListener("click", (e) => {
    const action = e.target.closest(".context-menu-item")?.dataset.action
    if (action) {
      handlePrivateUserContextAction(action)
      hidePrivateUserContextMenu()
    }
  })

  // 引用取消
  $("#replyPreviewCancel").addEventListener("click", () => {
    state.replyTo = null
    updateReplyPreview()
  })

  // message_id 回复取消
  $("#msgIdReplyPreviewCancel").addEventListener("click", () => {
    state.replyMsgId = null
    updateMsgIdReplyPreview()
  })

  // event_id 回复取消
  $("#eventIdReplyPreviewCancel").addEventListener("click", () => {
    state.replyEventId = null
    updateEventIdReplyPreview()
  })

  // message_id 回复开关
  $("#replyMsgIdToggle").addEventListener("change", (e) => {
    state.useReplyMsgId = e.target.checked
    // 关闭开关时清除已选中的 message_id 回复
    if (!state.useReplyMsgId && state.replyMsgId) {
      state.replyMsgId = null
      updateMsgIdReplyPreview()
    }
  })

  // 原始数据弹窗关闭
  $("#rawModalClose").addEventListener("click", () => {
    if (isMobile() && $("#rawModal").style.display === "flex") history.back()
    else $("#rawModal").style.display = "none"
  })
  $("#rawModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      if (isMobile()) history.back()
      else $("#rawModal").style.display = "none"
    }
  })

  // 群备注弹窗
  $("#noteModalClose").addEventListener("click", closeGroupNoteModal)
  $("#noteModalSave").addEventListener("click", saveGroupNote)
  $("#noteModalInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveGroupNote()
  })
  $("#groupNoteModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeGroupNoteModal()
  })
  // 绑定QQ群号弹窗
  $("#bindModalClose").addEventListener("click", closeBindGroupModal)
  $("#bindModalSave").addEventListener("click", saveBindGroupQQ)
  $("#bindModalInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveBindGroupQQ()
  })
  $("#bindGroupModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeBindGroupModal()
  })
  // 禁言弹窗
  $("#muteModalClose").addEventListener("click", closeMuteDialog)
  $("#muteModalConfirm").addEventListener("click", confirmMute)
  $("#muteModalInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmMute()
  })
  $("#muteModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeMuteDialog()
  })

  // 添加表情弹窗
  $("#emojiAddClose").addEventListener("click", closeEmojiAddModal)
  $("#emojiAddCancel").addEventListener("click", closeEmojiAddModal)
  $("#emojiAddConfirm").addEventListener("click", confirmEmojiAdd)
  $("#emojiAddModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeEmojiAddModal()
  })

  // 用户信息弹窗
  $("#userInfoModalClose").addEventListener("click", () => {
    if (isMobile() && $("#userInfoModal").style.display === "flex") history.back()
    else closeUserInfoModal()
  })
  $("#userInfoModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      if (isMobile()) history.back()
      else closeUserInfoModal()
    }
  })

  // 转发消息（聊天记录）弹窗
  $("#forwardModalClose").addEventListener("click", () => {
    if (isMobile() && $("#forwardModal").style.display === "flex") history.back()
    else closeForwardModal()
  })
  $("#forwardModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      if (isMobile()) history.back()
      else closeForwardModal()
    }
  })
  // 复制按钮（事件委托）
  $("#userInfoModal").addEventListener("click", (e) => {
    const btn = e.target.closest(".user-info-copy-btn")
    if (!btn) return
    const copyType = btn.dataset.copy
    let text = ""
    if (copyType === "union") text = $("#userInfoUnionId").textContent
    else if (copyType === "open") text = $("#userInfoOpenId").textContent
    else if (copyType === "uid") text = $("#userInfoUserId").textContent
    else if (copyType === "avatar") text = $("#userInfoAvatarUrl").textContent
    if (!text || text === "-") return
    function copyFallback() {
      const ta = document.createElement("textarea")
      ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px"
      document.body.appendChild(ta); ta.select()
      document.execCommand("copy"); document.body.removeChild(ta)
      btn.classList.add("copied")
      setTimeout(() => btn.classList.remove("copied"), 1200)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add("copied")
        setTimeout(() => btn.classList.remove("copied"), 1200)
      }).catch(() => copyFallback())
    } else {
      copyFallback()
    }
  })

  // 群信息弹窗：关闭
  $("#groupInfoModalClose").addEventListener("click", () => {
    if (isMobile() && $("#groupInfoModal").style.display === "flex") history.back()
    else closeGroupInfoModal()
  })
  $("#groupInfoModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      if (isMobile()) history.back()
      else closeGroupInfoModal()
    }
  })
  // 群信息弹窗：拉黑 / 取消拉黑
  $("#groupInfoBlBtn").addEventListener("click", async () => {
    const gid = currentGroupInfoId
    if (!gid) return
    const isBl = !!(state.groups.find(g => g.group_id === gid)?.is_blacklisted)
    try {
      if (isBl) await unblacklistGroupFromWeb(gid)
      else await blacklistGroupFromWeb(gid)
      const nowBl = !!(state.groups.find(g => g.group_id === gid)?.is_blacklisted)
      const btn = $("#groupInfoBlBtn")
      if (btn) {
        btn.textContent = nowBl ? "取消拉黑此群" : "拉黑此群"
        btn.classList.toggle("unbl", nowBl)
      }
    } catch (e) {
      console.error("群拉黑操作失败:", e)
    }
  })
  // 群信息弹窗：刷新群信息（立即从 getGroupInfo 重新获取）
  $("#groupInfoRefreshBtn").addEventListener("click", () => {
    if (currentGroupInfoId) refreshGroupInfo(currentGroupInfoId)
  })
  // 群信息弹窗：复制（事件委托）
  $("#groupInfoModal").addEventListener("click", (e) => {
    const btn = e.target.closest(".user-info-copy-btn")
    if (!btn) return
    const copyType = btn.dataset.copy
    const groupInfoCopyText = (type) => {
      if (type === "openid") return $("#groupInfoOpenId").textContent
      if (type === "member_num") return $("#groupInfoMemberNum").textContent
      if (type === "avatar_url") return $("#groupInfoAvatarUrl").textContent
      if (type === "note") return $("#groupInfoNote").textContent
      if (type === "finger_memo") return $("#groupInfoFingerMemo").textContent
      if (type === "class_text") return $("#groupInfoClassText").textContent
      return ""
    }
    const text = groupInfoCopyText(copyType)
    if (!text || text === "-") return
    function copyFallback() {
      const ta = document.createElement("textarea")
      ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px"
      document.body.appendChild(ta); ta.select()
      document.execCommand("copy"); document.body.removeChild(ta)
      btn.classList.add("copied")
      setTimeout(() => btn.classList.remove("copied"), 1200)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add("copied")
        setTimeout(() => btn.classList.remove("copied"), 1200)
      }).catch(() => copyFallback())
    } else {
      copyFallback()
    }
  })
  // 群信息弹窗：复制群名
  $("#groupInfoCopyName").addEventListener("click", () => {
    const text = $("#groupInfoName").textContent
    if (!text || text === "加载中…") return
    const btn = $("#groupInfoCopyName")
    function copyNameFallback() {
      const ta = document.createElement("textarea")
      ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px"
      document.body.appendChild(ta); ta.select()
      document.execCommand("copy"); document.body.removeChild(ta)
      btn.classList.add("copied")
      setTimeout(() => btn.classList.remove("copied"), 1200)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add("copied")
        setTimeout(() => btn.classList.remove("copied"), 1200)
      }).catch(() => copyNameFallback())
    } else {
      copyNameFallback()
    }
  })
  // 昵称复制
  $("#userInfoCopyNick").addEventListener("click", () => {
    const text = $("#userInfoNick").textContent
    if (!text) return
    const btn = $("#userInfoCopyNick")
    function copyNickFallback() {
      const ta = document.createElement("textarea")
      ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px"
      document.body.appendChild(ta); ta.select()
      document.execCommand("copy"); document.body.removeChild(ta)
      btn.classList.add("copied")
      setTimeout(() => btn.classList.remove("copied"), 1200)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add("copied")
        setTimeout(() => btn.classList.remove("copied"), 1200)
      }).catch(() => copyNickFallback())
    } else {
      copyNickFallback()
    }
  })
  // 头像链接跳转
  const jumpBtn = $("#userInfoJumpAvatar")
  if (jumpBtn) {
    jumpBtn.addEventListener("click", () => {
      const url = $("#userInfoAvatarUrl").textContent
      if (url && url !== "-") window.open(url, "_blank")
    })
  }
  // 群头像链接跳转
  const groupJumpBtn = $("#groupInfoJumpAvatar")
  if (groupJumpBtn) {
    groupJumpBtn.addEventListener("click", () => {
      const url = $("#groupInfoAvatarUrl").href
      if (url && url !== "#" && url !== "null") window.open(url, "_blank")
    })
  }

  // 用户信息弹窗 - 拉黑/取消拉黑按钮
  $("#userInfoBlBtn").addEventListener("click", async () => {
    if (!userInfoCurrentData || !state.currentBotId) return
    const { openid, unionid } = userInfoCurrentData
    try {
      await api(`/bot/${state.currentBotId}/blacklist/user`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openid, unionid }),
      })
      showToast("已拉黑用户")
      closeUserInfoModal()
      await loadBlacklistData()
      reRenderCurrentMessages()
      renderPrivateChatList()
      if (state.chatType === "group") renderGroupList()
      // 如果当前在黑名单页面，也刷新
      if (state.currentPage === "blacklist") loadBlacklist()
    } catch (err) {
      console.error("拉黑用户失败:", err)
      showToast("拉黑失败: " + err.message)
    }
  })
  $("#userInfoUnblBtn").addEventListener("click", async () => {
    if (!userInfoCurrentData || !state.currentBotId) return
    const { openid, unionid } = userInfoCurrentData
    try {
      await api(`/bot/${state.currentBotId}/blacklist/user`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openid, unionid }),
      })
      showToast("已取消拉黑用户")
      closeUserInfoModal()
      await loadBlacklistData()
      reRenderCurrentMessages()
      renderPrivateChatList()
      if (state.chatType === "group") renderGroupList()
      // 如果当前在黑名单页面，也刷新
      if (state.currentPage === "blacklist") loadBlacklist()
    } catch (err) {
      console.error("取消拉黑用户失败:", err)
      showToast("取消拉黑失败: " + err.message)
    }
  })

  // 音频/视频播放（事件委托）
  $("#chatMessages").addEventListener("click", (e) => {
    const audioBtn = e.target.closest(".audio-play-btn")
    if (audioBtn) {
      e.preventDefault()
      toggleAudioPlay(audioBtn)
      return
    }
    const videoBtn = e.target.closest(".video-play-btn-circle")
    if (videoBtn) {
      e.preventDefault()
      toggleVideoPlay(videoBtn)
      return
    }
  })

  // 转发弹窗内的音视频播放（聊天列表的事件委托不覆盖弹窗内容）
  const forwardBody = $("#forwardBody")
  if (forwardBody) {
    forwardBody.addEventListener("click", (e) => {
      // 嵌套聊天记录卡片：点击在当前弹窗内下钻查看（QQ 风格）
      const nestedBubble = e.target.closest(".fwd-nested-bubble")
      if (nestedBubble) {
        const id = Number(nestedBubble.dataset.nestedId)
        const nested = _fwdNestedMap.get(id)
        if (nested) openForwardModal(nested)
        e.stopPropagation()
        return
      }
      const audioBtn = e.target.closest(".audio-play-btn")
      if (audioBtn) {
        e.preventDefault()
        toggleAudioPlay(audioBtn)
        return
      }
      const videoBtn = e.target.closest(".video-play-btn-circle")
      if (videoBtn) {
        e.preventDefault()
        toggleVideoPlay(videoBtn)
        return
      }
    })
  }

  // 滚动加载
  setupScrollHandler()

  // 退出登录
  const logoutBtn = $("#logoutBtn")
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await fetch(`${API_BASE}/logout`, { method: "POST" })
      } catch {}
      window.location.href = `${WEB_BASE}/`
    })
  }

  // 添加 Bot 弹窗
  initAddBotModal()

  // 侧边栏折叠/展开切换（独立底部按钮，非 nav-item，不触发页面导航）
  const sidebar = $("#sidebar")
  const sidebarToggle = $("#sidebarToggle")
  if (sidebar && sidebarToggle) {
    const updateToggleUI = () => {
      const isCollapsed = sidebar.classList.contains("collapsed")
      const textEl = sidebarToggle.querySelector(".sidebar-toggle-text")
      if (textEl) textEl.textContent = isCollapsed ? "展开" : "收起"
    }

    // 读取用户偏好
    const savedCollapsed = localStorage.getItem("sidebar_collapsed")
    if (savedCollapsed === "true") {
      sidebar.classList.add("collapsed")
    }
    updateToggleUI()

    sidebarToggle.addEventListener("click", () => {
      sidebar.classList.toggle("collapsed")
      const isCollapsed = sidebar.classList.contains("collapsed")
      localStorage.setItem("sidebar_collapsed", isCollapsed ? "true" : "false")
      updateToggleUI()
    })
  }

  // 设置页面事件
  setupSettingsListeners()
  const settingsSaveBtn = $("#settingsSaveBtn")
  if (settingsSaveBtn) {
    settingsSaveBtn.addEventListener("click", handleSettingsSave)
  }

  // 验证码弹窗事件
  setupCodeModalListeners()
}

// ===== 设置页面 =====
let settingsOriginal = {}  // 原始配置快照

async function loadSettings() {
  try {
    const cfg = await api("/config")
    settingsOriginal = { ...cfg, login: { ...cfg.login } }
    $("#setBasePath").value = cfg.basePath || ""
    $("#setLoginEnabled").checked = cfg.login.enabled !== false
    $("#setAutoRecordMessage").checked = cfg.autoRecordMessage !== false
    $("#setAutoDownloadImgorVideo").checked = cfg.autoDownloadImgorVideo !== false
    $("#setSaveTimes").value = cfg.saveTimes || 3
    $("#setMaxMediaCacheSize").value = cfg.maxMediaCacheSize || 10
    $("#setStorageBackend").value = cfg.storageBackend === "sqlite" ? "sqlite" : "redis"
    $("#setUsername").value = cfg.login.username || ""
    $("#setPassword").value = cfg.login.password || ""
    $("#setNotifyUserId").value = cfg.notifyUserId || ""
    $("#setPublicAccess").checked = cfg.publicAccess === true
    $("#setEnableQuanliangCommands").checked = cfg.enableQuanliangCommands !== false
    $("#setHttpLogSilent").checked = cfg.httpLogSilent === true

    // 给问号提示添加智能定位：窄屏下不溢出
    $$(".settings-help").forEach(el => {
      el.addEventListener("mouseenter", () => positionSettingsTooltip(el))
    })

    // 加载缓存大小
    try {
      const cs = await api("/cache-size")
      const el = $("#cacheSizeDisplay")
      if (el && cs) el.textContent = `当前缓存：${cs.fileCount} 个文件，${formatSize(cs.size)}`
    } catch { /* 获取失败不影响主流程 */ }
    checkSettingsChanged()
  } catch (err) {
    console.error("加载设置失败:", err)
  }
}

function getCurrentSettings() {
  return {
    basePath: $("#setBasePath").value.trim(),
    autoRecordMessage: $("#setAutoRecordMessage").checked,
    autoDownloadImgorVideo: $("#setAutoDownloadImgorVideo").checked,
    saveTimes: Number($("#setSaveTimes").value) || 3,
    maxMediaCacheSize: Math.min(100, Math.max(1, parseInt($("#setMaxMediaCacheSize").value) || 10)),
    storageBackend: $("#setStorageBackend").value,
    login: {
      enabled: $("#setLoginEnabled").checked,
      username: $("#setUsername").value.trim(),
      password: $("#setPassword").value,
    },
    notifyUserId: $("#setNotifyUserId").value.trim(),
    publicAccess: $("#setPublicAccess").checked,
    enableQuanliangCommands: $("#setEnableQuanliangCommands").checked,
    httpLogSilent: $("#setHttpLogSilent").checked,
  }
}

// 问号提示智能定位：窄屏下自动左移防止溢出
function positionSettingsTooltip(el) {
  const tipW = 280  // CSS 中 .settings-help::after 的 width
  const padding = 16 // 与屏幕边缘的间距
  const rect = el.getBoundingClientRect()
  const centerX = rect.left + rect.width / 2
  const rightEdge = centerX + tipW / 2
  const leftEdge = centerX - tipW / 2
  let shift = 0
  if (rightEdge > window.innerWidth - padding) {
    shift = rightEdge - window.innerWidth + padding
  } else if (leftEdge < padding) {
    shift = -(padding - leftEdge)
  }
  el.style.setProperty("--help-shift", `${-shift}px`)
}

function checkSettingsChanged() {
  const cur = getCurrentSettings()
  const orig = settingsOriginal
  const changed =
    cur.basePath !== orig.basePath ||
    cur.autoRecordMessage !== orig.autoRecordMessage ||
    cur.autoDownloadImgorVideo !== orig.autoDownloadImgorVideo ||
    cur.saveTimes !== orig.saveTimes ||
    cur.maxMediaCacheSize !== orig.maxMediaCacheSize ||
    cur.storageBackend !== (orig.storageBackend || "redis") ||
    cur.login.enabled !== orig.login.enabled ||
    cur.login.username !== orig.login.username ||
    cur.login.password !== orig.login.password ||
    cur.notifyUserId !== (orig.notifyUserId || "") ||
    cur.enableQuanliangCommands !== orig.enableQuanliangCommands ||
    cur.httpLogSilent !== (orig.httpLogSilent === true) ||
    cur.publicAccess !== (orig.publicAccess === true)
  const btn = $("#settingsSaveBtn")
  btn.disabled = !changed
  $("#settingsSavedHint").style.display = "none"
  return { changed, cur, orig }
}

// 输入框变化时检查
function setupSettingsListeners() {
  for (const id of ["setBasePath", "setUsername", "setPassword", "setNotifyUserId"]) {
    const el = $("#" + id)
    if (el) el.addEventListener("input", checkSettingsChanged)
  }
  for (const id of ["setLoginEnabled", "setAutoRecordMessage", "setAutoDownloadImgorVideo", "setEnableQuanliangCommands", "setHttpLogSilent", "setPublicAccess"]) {
    const toggle = $("#" + id)
    if (toggle) toggle.addEventListener("change", checkSettingsChanged)
  }
  const sel = $("#setSaveTimes")
  if (sel) sel.addEventListener("change", checkSettingsChanged)
  const backendSel = $("#setStorageBackend")
  if (backendSel) backendSel.addEventListener("change", checkSettingsChanged)
  const sizeInput = $("#setMaxMediaCacheSize")
  if (sizeInput) sizeInput.addEventListener("input", checkSettingsChanged)
}

// 判断是否有敏感字段变更
function hasSensitiveChange(cur, orig) {
  return cur.basePath !== orig.basePath ||
    cur.login.enabled !== orig.login.enabled ||
    cur.login.username !== orig.login.username ||
    (cur.login.password !== "••••••••" && cur.login.password !== orig.login.password) ||
    cur.notifyUserId !== (orig.notifyUserId || "") ||
    cur.storageBackend !== (orig.storageBackend || "redis")
}

// 保存按钮点击
async function handleSettingsSave() {
  const { changed, cur, orig } = checkSettingsChanged()
  if (!changed) return

  // 如果有敏感变更，弹出验证码
  if (hasSensitiveChange(cur, orig)) {
    openCodeModal(cur, orig)
  } else {
    await doSaveConfig(cur)
  }
}

function flattenPayload(cur, orig) {
  const payload = {}
  if (!orig || cur.basePath !== orig.basePath) payload.basePath = cur.basePath
  if (!orig || cur.autoRecordMessage !== orig.autoRecordMessage) payload.autoRecordMessage = cur.autoRecordMessage
  if (!orig || cur.autoDownloadImgorVideo !== orig.autoDownloadImgorVideo) payload.autoDownloadImgorVideo = cur.autoDownloadImgorVideo
  if (!orig || cur.saveTimes !== orig.saveTimes) payload.saveTimes = cur.saveTimes
  if (!orig || cur.maxMediaCacheSize !== orig.maxMediaCacheSize) payload.maxMediaCacheSize = cur.maxMediaCacheSize
  if (!orig || cur.storageBackend !== (orig.storageBackend || "redis")) payload.storageBackend = cur.storageBackend
  if (!orig || cur.login.enabled !== orig.login.enabled) payload.loginEnabled = cur.login.enabled
  if (!orig || cur.login.username !== orig.login.username) payload.username = cur.login.username
  if (!orig || (cur.login.password && cur.login.password !== "••••••••" && cur.login.password !== orig.login.password)) payload.password = cur.login.password
  if (!orig || cur.notifyUserId !== (orig.notifyUserId || "")) payload.notifyUserId = cur.notifyUserId
  if (!orig || cur.enableQuanliangCommands !== orig.enableQuanliangCommands) payload.enableQuanliangCommands = cur.enableQuanliangCommands
  if (!orig || cur.httpLogSilent !== (orig.httpLogSilent === true)) payload.httpLogSilent = cur.httpLogSilent
  if (!orig || cur.publicAccess !== (orig.publicAccess === true)) payload.publicAccess = cur.publicAccess
  return payload
}

async function doSaveConfig(cur) {
  try {
    const payload = flattenPayload(cur, settingsOriginal)
    const res = await api("/config/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      settingsOriginal = { ...cur, login: { ...cur.login } }
      if (cur.login?.password && cur.login.password !== "••••••••") {
        settingsOriginal.login.password = "••••••••"
      }
      const hint = $("#settingsSavedHint")
      hint.textContent = "已保存（重启后生效）"
      hint.style.display = "inline"
      setTimeout(() => { hint.style.display = "none" }, 4000)
      checkSettingsChanged()
    } else {
      alert("保存失败: " + (res.error || "未知错误"))
    }
  } catch (err) {
    alert("保存失败: " + err.message)
  }
}

// ===== 验证码弹窗 =====
let codeResolve = null
let codeReject = null
let codeAttempts = 0
let codeModalCur = null
let codeModalOrig = null

async function openCodeModal(cur, orig) {
  codeModalCur = cur
  codeModalOrig = orig
  codeAttempts = 0
  const modal = $("#codeModal")
  const input = $("#codeModalInput")
  const errorEl = $("#codeModalError")
  const attemptsEl = $("#codeModalAttempts")

  input.value = ""
  errorEl.textContent = ""
  attemptsEl.textContent = ""

  // 先请求验证码
  try {
    await api("/config/send-code", { method: "POST" })
  } catch (err) {
    errorEl.textContent = "获取验证码失败: " + err.message
  }

  modal.style.display = "flex"
  setTimeout(() => input.focus(), 150)

  return new Promise((resolve, reject) => {
    codeResolve = resolve
    codeReject = reject
  })
}

function closeCodeModal() {
  $("#codeModal").style.display = "none"
  if (codeReject) { codeReject(new Error("取消")); codeReject = null }
}

async function handleCodeConfirm() {
  const input = $("#codeModalInput")
  const errorEl = $("#codeModalError")
  const code = input.value.trim()

  if (!code || code.length !== 32) {
    errorEl.textContent = "请输入32位验证码"
    return
  }

  const payload = {
    ...flattenPayload(codeModalCur, codeModalOrig),
    code,
  }

  try {
    const res = await api("/config/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      settingsOriginal = { ...codeModalCur, login: { ...codeModalCur.login } }
      if (codeModalCur.login?.password && codeModalCur.login.password !== "••••••••") {
        settingsOriginal.login.password = "••••••••"
      }
      const hint = $("#settingsSavedHint")
      hint.textContent = "已保存（重启后生效）"
      hint.style.display = "inline"
      setTimeout(() => { hint.style.display = "none" }, 4000)
      checkSettingsChanged()
      closeCodeModal()
    } else {
      errorEl.textContent = res.error || "保存失败"
      input.value = ""
      input.focus()
    }
  } catch (err) {
    errorEl.textContent = "保存失败: " + err.message
  }
}

async function handleCodeResend() {
  const errorEl = $("#codeModalError")
  const input = $("#codeModalInput")
  errorEl.textContent = ""
  input.value = ""
  try {
    await api("/config/send-code", { method: "POST" })
    errorEl.textContent = "验证码已重新发送到日志"
  } catch (err) {
    errorEl.textContent = "获取验证码失败: " + err.message
  }
}

function setupCodeModalListeners() {
  $("#codeModalClose").addEventListener("click", closeCodeModal)
  $("#codeModalConfirm").addEventListener("click", handleCodeConfirm)
  $("#codeModalResend").addEventListener("click", handleCodeResend)
  $("#codeModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeCodeModal()
  })
  $("#codeModalInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleCodeConfirm()
  })
}

// ===== 黑名单页面 =====
async function loadBlacklist() {
  const contentEl = $("#blacklistContent")
  const usersEl = $("#blacklistUsers")
  const groupsEl = $("#blacklistGroups")

  if (!state.currentBotId) {
    contentEl.style.display = "none"
    return
  }

  contentEl.style.display = ""

  // 显示加载状态
  usersEl.innerHTML = '<div class="blacklist-empty">加载中...</div>'
  groupsEl.innerHTML = '<div class="blacklist-empty">加载中...</div>'

  try {
    const data = await api(`/bot/${state.currentBotId}/blacklist`)
    renderBlacklistedUsers(data.users || [])
    renderBlacklistedGroups(data.groups || [])
  } catch (err) {
    console.error("[loadBlacklist] 加载黑名单失败:", err)
    usersEl.innerHTML = '<div class="blacklist-empty">加载失败</div>'
    groupsEl.innerHTML = '<div class="blacklist-empty">加载失败</div>'
  }
}

function renderBlacklistedUsers(users) {
  const el = $("#blacklistUsers")
  if (!users.length) {
    el.innerHTML = '<div class="blacklist-empty">暂无黑名单用户</div>'
    return
  }
  el.innerHTML = ''
  const fragment = document.createDocumentFragment()
  for (const u of users) {
    const div = document.createElement("div")
    div.className = "blacklist-item"
    // 点击弹出用户信息弹窗
    div.style.cursor = "pointer"
    div.addEventListener("click", () => {
      showUserInfoModal({
        nickname: u.nickname,
        avatar: u.avatar,
        openid: u.openid,
        unionid: u.unionid || "",
        user_id: u.openid,
      }, "blacklist")
    })
    const avatarUrl = u.avatar || ''
    const initial = (u.nickname || u.openid || '?')[0]
    const avatarHtml = avatarUrl
      ? `<img class="blacklist-item-avatar" src="${escHtml(avatarUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="blacklist-item-avatar" style="display:flex;align-items:center;justify-content:center;background:#ddd;color:#666;font-size:14px;font-weight:bold;border-radius:50%">${escHtml(initial)}</div>`
    const safeOpenid = escHtml(u.openid)
    const safeUnionid = escHtml(u.unionid || '')
    div.innerHTML = avatarHtml
      + '<div class="blacklist-item-info">'
      + '<div class="blacklist-item-name">' + escHtml(u.nickname) + '</div>'
      + '<div class="blacklist-item-id">OpenID: ' + safeOpenid + '</div>'
      + (u.unionid ? '<div class="blacklist-item-unionid">UnionID: ' + safeUnionid + '</div>' : '')
      + '</div>'
      + '<button class="blacklist-unblock-btn" onclick="event.stopPropagation();unblockUser(\'' + safeOpenid + '\', \'' + safeUnionid + '\')">取消拉黑</button>'
    fragment.appendChild(div)
  }
  el.appendChild(fragment)
}

function renderBlacklistedGroups(groups) {
  const el = $("#blacklistGroups")
  if (!groups.length) {
    el.innerHTML = '<div class="blacklist-empty">暂无黑名单群聊</div>'
    return
  }
  el.innerHTML = groups.map(g => {
    const qq = g.bound_qq
    let avatarHtml
    if (qq) {
      const avatarUrl = `http://p.qlogo.cn/gh/${qq}/${qq}/640`
      avatarHtml = `<img class="blacklist-item-avatar" src="${escHtml(avatarUrl)}" alt="" onerror="this.outerHTML='<div class=\\'blacklist-item-avatar\\' style=\\'display:flex;align-items:center;justify-content:center;font-size:16px\\'>👥</div>'">`
    } else {
      avatarHtml = `<div class="blacklist-item-avatar" style="display:flex;align-items:center;justify-content:center;font-size:16px;">👥</div>`
    }
    return `
    <div class="blacklist-item">
      ${avatarHtml}
      <div class="blacklist-item-info">
        <div class="blacklist-item-name">${escHtml(g.group_name)}</div>
        <div class="blacklist-item-id">GroupID: ${escHtml(g.group_id)}</div>
      </div>
      <button class="blacklist-unblock-btn" onclick="unblockGroup('${escHtml(g.group_id)}')">取消拉黑</button>
    </div>
  `}).join('')
}

async function unblockUser(openid, unionid) {
  if (!state.currentBotId) return
  if (!confirm(`确定取消拉黑用户 ${openid}？`)) return
  try {
    await api(`/bot/${state.currentBotId}/blacklist/user`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openid, unionid }),
    })
    showToast("已取消拉黑用户")
    loadBlacklist()
    // 同步更新全局黑名单 + 消息记录 + 聊天列表（await 确保黑名单数据已更新后再渲染）
    await loadBlacklistData()
    reRenderCurrentMessages()
    renderPrivateChatList()
    if (state.chatType === "group") renderGroupList()
  } catch (err) {
    console.error("[unblockUser] 取消拉黑失败:", err)
    showToast("取消拉黑失败: " + err.message)
  }
}

async function unblockGroup(groupId) {
  if (!state.currentBotId) return
  if (!confirm(`确定取消拉黑群 ${groupId}？`)) return
  try {
    await api(`/bot/${state.currentBotId}/blacklist/group`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: groupId }),
    })
    showToast("已取消拉黑群聊")
    loadBlacklist()
    // 同步更新全局黑名单 + 消息记录 + 群列表（await 确保数据已更新后再渲染）
    await loadBlacklistData()
    reRenderCurrentMessages()
    renderGroupList()
    renderPrivateChatList()
  } catch (err) {
    console.error("[unblockGroup] 取消拉黑失败:", err)
    showToast("取消拉黑失败: " + err.message)
  }
}

// ===== 添加 Bot 弹窗 =====
function initAddBotModal() {
  const modal = $("#addBotModal")
  const addBtn = $("#addBotBtn")
  const closeBtn = $("#modalCloseBtn")
  // 面板/按钮引用
  const tabAppid = $(".modal-tab[data-tab='appid']")
  const tabQrcode = $(".modal-tab[data-tab='qrcode']")
  const panelAppid = $("#panelAppid")
  const panelQrcode = $("#panelQrcode")
  const inputAppid = $("#inputAppid")
  const inputSecret = $("#inputSecret")
  const appidError = $("#appidError")
  const btnAppidLogin = $("#btnAppidLogin")
  const btnQrStart = $("#btnQrStart")
  const qrStatus = $("#qrStatus")
  const qrImgWrap = $("#qrImgWrap")
  const qrImage = $("#qrImage")
  const privateDomainGroup = $("#privateDomainGroup")
  if (!modal || !addBtn) return

  let qrTimer = null, qrTaskId = null, qrKey = null

  // 重置表单
  function resetForm() {
    if (inputAppid) inputAppid.value = ""
    if (inputSecret) inputSecret.value = ""
    if (appidError) appidError.style.display = "none"
    if (btnAppidLogin) { btnAppidLogin.disabled = false; btnAppidLogin.textContent = "登录" }
    if (qrStatus) qrStatus.textContent = "正在生成二维码..."
    if (qrImgWrap) qrImgWrap.style.display = "none"
    if (btnQrStart) { btnQrStart.disabled = false; btnQrStart.textContent = "刷新二维码" }
    clearQRPolling()
    clearQRImage()
    // 默认选中 AppID tab
    if (tabAppid) tabAppid.click()
  }

  function clearQRPolling() {
    if (qrTimer) { clearInterval(qrTimer); qrTimer = null }
    qrTaskId = null; qrKey = null
  }

  function clearQRImage() {
    if (qrImage) qrImage.src = ""
  }

  // 打开弹窗
  addBtn.addEventListener("click", () => {
    resetForm()
    modal.style.display = "flex"
  })

  // 关闭弹窗
  function closeModal() {
    clearQRPolling()
    modal.style.display = "none"
  }
  if (closeBtn) closeBtn.addEventListener("click", closeModal)
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal()
  })

  // Tab 切换
  if (tabAppid && tabQrcode) {
    tabAppid.addEventListener("click", () => {
      tabAppid.classList.add("active")
      tabQrcode.classList.remove("active")
      if (panelAppid) panelAppid.style.display = ""
      if (panelQrcode) panelQrcode.style.display = "none"
      clearQRPolling()
    })
    tabQrcode.addEventListener("click", () => {
      tabQrcode.classList.add("active")
      tabAppid.classList.remove("active")
      if (panelQrcode) panelQrcode.style.display = ""
      if (panelAppid) panelAppid.style.display = "none"
      // 切到扫码 Tab 自动生成二维码（有缓存则复用）
      if (!qrTaskId) autoStartQR()
    })
  }

  // 连接方式切换时显示/隐藏公私域选项
  const wsRadio = $("input[name='connMode'][value='ws']")
  const whRadio = $("input[name='connMode'][value='webhook']")
  function updatePrivateDomain() {
    if (!privateDomainGroup) return
    const mode = $("input[name='connMode']:checked")?.value
    privateDomainGroup.style.display = mode === "webhook" ? "none" : ""
  }
  if (wsRadio) wsRadio.addEventListener("change", updatePrivateDomain)
  if (whRadio) whRadio.addEventListener("change", updatePrivateDomain)

  // AppID 登录
  if (btnAppidLogin) {
    btnAppidLogin.addEventListener("click", async () => {
      const appid = inputAppid?.value?.trim()
      const secret = inputSecret?.value?.trim()
      if (!appid) return showError("请输入 AppID")
      if (!secret) return showError("请输入 AppSecret")
      btnAppidLogin.disabled = true
      btnAppidLogin.textContent = "验证中..."
      if (appidError) appidError.style.display = "none"
      try {
        const mode = $("input[name='connMode']:checked")?.value || "ws"
        const pd = $("input[name='privateDomain']:checked")?.value || "0"
        const res = await fetch(`${API_BASE}/bot/add-by-appid`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appid, secret, mode, privateDomain: pd === "1" }),
        })
        const data = await res.json()
        if (!res.ok || !data.ok) {
          showError(data.error || "添加失败")
        } else {
          showToast(`Bot ${data.uin} ${data.existed ? "配置已更新" : "添加成功"}`)
          setTimeout(closeModal, 1500)
        }
      } catch (err) {
        showError("网络错误: " + err.message)
      }
      btnAppidLogin.disabled = false
      btnAppidLogin.textContent = "登录"
    })
  }

  function showError(msg) {
    if (!appidError) return
    appidError.textContent = msg
    appidError.style.display = ""
  }

  // 扫码登录 - 自动生成 + 轮询
  async function autoStartQR(forceRefresh = false) {
    clearQRPolling()
    if (qrImgWrap) qrImgWrap.style.display = "none"
    clearQRImage()
    if (qrStatus) qrStatus.textContent = "正在生成二维码..."
    if (btnQrStart) { btnQrStart.disabled = true; btnQrStart.textContent = "生成中..." }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    try {
      const res = await fetch(`${API_BASE}/bot/add-qr-start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh: forceRefresh }),
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      const data = await res.json()
      if (!res.ok || !data.ok) {
        if (qrStatus) qrStatus.textContent = "生成失败: " + (data.error || "未知错误")
        if (btnQrStart) { btnQrStart.disabled = false; btnQrStart.textContent = "重试" }
        if (qrImgWrap) qrImgWrap.style.display = "none"
        return
      }
      qrTaskId = data.taskId
      qrKey = data.key
      if (qrImage && data.qrImage) qrImage.src = data.qrImage
      if (qrImgWrap) qrImgWrap.style.display = ""
      if (qrStatus) qrStatus.textContent = data.cached ? "复用上次二维码，请扫码" : "请使用手机 QQ 扫描二维码"
      if (btnQrStart) { btnQrStart.disabled = false; btnQrStart.textContent = "刷新二维码" }

      // 轮询结果
      startQRPolling()
    } catch (err) {
      clearTimeout(timer)
      if (qrStatus) qrStatus.textContent = err.name === "AbortError" ? "请求超时，请重试" : "网络错误: " + err.message
      if (btnQrStart) { btnQrStart.disabled = false; btnQrStart.textContent = "重试" }
      if (qrImgWrap) qrImgWrap.style.display = "none"
    }
  }

  function startQRPolling() {
    if (qrTimer) clearInterval(qrTimer)
    qrTimer = setInterval(async () => {
      if (!qrTaskId || !qrKey) return
      try {
        const pollRes = await fetch(`${API_BASE}/bot/add-qr-poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: qrTaskId, key: qrKey }),
        })
        const pollData = await pollRes.json()
        if (pollData.status === "ok") {
          clearQRPolling()
          if (qrStatus) qrStatus.textContent = `Bot ${pollData.uin} ${pollData.existed ? "配置已更新" : "添加成功"}`
          showToast(`Bot ${pollData.uin} ${pollData.existed ? "配置已更新" : "添加成功"}`)
          setTimeout(closeModal, 1500)
        } else if (pollData.status === "timeout") {
          clearQRPolling()
          if (qrStatus) qrStatus.textContent = "扫码超时，请刷新二维码"
          if (btnQrStart) { btnQrStart.disabled = false; btnQrStart.textContent = "刷新二维码" }
          if (qrImgWrap) qrImgWrap.style.display = "none"
        }
      } catch {}
    }, 2000)
  }

  if (btnQrStart) {
    btnQrStart.addEventListener("click", () => autoStartQR(true))
  }

}

// ===== 初始化 =====
let wasMobile = isMobile()

async function init() {
  console.log("========== QQBot-Web v2 (debug) 初始化 ==========")
  setupEventListeners()
  bindEmojiPickerEvents()
  connectWebSocket()
  console.log("[init] 事件绑定完成，开始 loadBots")
  await loadBots()
  loadWebPages()
  loadBlacklistData()
  console.log("[init] loadBots 完成, currentBotId:", state.currentBotId, "currentPage:", state.currentPage)
  if (state.currentBotId) {
    updateDashboard()
    startDashboardAutoRefresh()
  }

  // 窗口尺寸变化时更新布局
  window.addEventListener("resize", () => {
    const nowMobile = isMobile()
    if (nowMobile !== wasMobile) {
      wasMobile = nowMobile
      if (nowMobile) {
        // 切到移动端：如果有聊天视图打开，保持现状
        if (!state.currentGroupId) showMobileGroupList()
      } else {
        // 切到 PC：恢复完整布局
        resetChatView()
        if (state.currentGroupId) {
          openChat(state.currentGroupId)
        }
      }
    }
  })
}

// ========== 表情包选择 ==========
const emojiState = {
  open: false,
  mode: "editor",      // editor | ark
  arkTarget: null,     // ark 输入框 id
  lists: [],           // [{ folder, icon, title, order, count }]
  activeFolder: null,
  dragList: null,      // 正在拖动的列表 folder
  dragEmoji: null,     // 正在拖动的表情 file
  selectMode: false,   // 表情多选模式
  selected: new Set(), // 多选模式下选中的 file 集合
  currentEmojis: [],   // 当前网格表情数据（用于重渲染）
  editFolder: null,    // 正在编辑设置的列表 folder
  editIconFile: null,  // 编辑时新选的图标文件
}

const ICON_PALETTE = ["😀","😂","🥰","😎","🤩","🐱","🐶","🌟","🔥","🍔","⚽","🎮","❤️","👍","🌈","💡","🎉","🚀","☕","🌸","🐼","🦊","🍎","🎵"]

function emojiStaticUrl(folder, file) {
  return `${WEB_BASE}/emoji-static/${folder}/${encodeURIComponent(file)}`
}

async function openEmojiPicker(opts) {
  emojiState.open = true
  emojiState.mode = opts.mode || "editor"
  emojiState.arkTarget = opts.target || null
  $("#emojiPickerModal").style.display = "flex"
  await loadEmojiLists()
}

function closeEmojiPicker() {
  emojiState.open = false
  emojiState.selectMode = false
  emojiState.selected.clear()
  closeEmojiContextMenu()
  $("#emojiPickerModal").style.display = "none"
}

async function loadEmojiLists() {
  try {
    const data = await api("/emoji/lists")
    emojiState.lists = Array.isArray(data.lists) ? data.lists : []
    if (!emojiState.activeFolder && emojiState.lists.length) {
      emojiState.activeFolder = emojiState.lists[0].folder
    }
    if (emojiState.activeFolder && !emojiState.lists.find(l => l.folder === emojiState.activeFolder)) {
      emojiState.activeFolder = emojiState.lists.length ? emojiState.lists[0].folder : null
    }
    renderEmojiListBar()
    if (emojiState.activeFolder) {
      await loadEmojiGrid(emojiState.activeFolder)
    } else {
      renderEmojiGrid([])
    }
  } catch (e) {
    console.error("[emoji] 列表加载失败:", e)
    showToast("表情列表加载失败")
  }
}

function renderEmojiListBar() {
  const wrap = $("#emojiListItems")
  wrap.innerHTML = ""
  emojiState.lists.forEach((l) => {
    const item = document.createElement("div")
    item.className = "emoji-list-item" + (l.folder === emojiState.activeFolder ? " active" : "")
    item.dataset.folder = l.folder
    item.setAttribute("draggable", "true")
    const iconHtml = l.icon
      ? (l.icon.includes(".") ? `<img src="${emojiStaticUrl("icon", l.icon)}" alt="">` : l.icon)
      : `<span class="emoji-default-icon">📁</span>`
    item.innerHTML = `<div class="emoji-list-icon">${iconHtml}</div><div class="emoji-list-title">${escapeHtml(l.title)}</div>`
    item.addEventListener("click", () => {
      emojiState.activeFolder = l.folder
      renderEmojiListBar()
      loadEmojiGrid(l.folder)
    })
    // 原生拖拽
    item.addEventListener("dragstart", (ev) => onListDragStart(ev, l.folder, item))
    item.addEventListener("dragover", (ev) => onListDragOver(ev, l.folder, item, "item"))
    item.addEventListener("dragleave", () => item.classList.remove("drag-target"))
    item.addEventListener("drop", (ev) => onListDrop(ev, l.folder, item))
    // 右键菜单：修改设置 / 删除
    item.addEventListener("contextmenu", (ev) => {
      ev.preventDefault()
      showEmojiListMenu(ev, l)
    })
    wrap.appendChild(item)
  })
}

// 列表插入占位（拖到此处 = 插到某列表前面/后面）
async function loadEmojiGrid(folder) {
  try {
    // 打开列表时自动同步：载入文件夹内未记录的图片并清除失效记录
    await api(`/emoji/lists/${encodeURIComponent(folder)}/sync`, { method: "POST" }).catch(() => {})
    const data = await api(`/emoji/lists/${encodeURIComponent(folder)}/emojis`)
    renderEmojiGrid(Array.isArray(data.emojis) ? data.emojis : [])
  } catch (e) {
    renderEmojiGrid([])
  }
}

function renderEmojiGrid(emojis) {
  emojiState.currentEmojis = emojis
  const grid = $("#emojiGrid")
  grid.innerHTML = ""
  // 第一个位置固定为「+ 添加表情图片」虚线单元（勾选模式下不显示）
  if (!emojiState.selectMode) {
    const addCell = document.createElement("div")
    addCell.className = "emoji-cell emoji-add-cell"
    addCell.title = "添加表情图片"
    addCell.textContent = "+"
    addCell.addEventListener("click", pickEmojiImages)
    grid.appendChild(addCell)
  }
  if (!emojis.length) {
    const tip = document.createElement("div")
    tip.className = "emoji-grid-empty"
    tip.textContent = emojiState.selectMode ? "列表为空" : "列表为空，点击左侧「+」添加表情图片"
    grid.appendChild(tip)
    return
  }
  for (const e of emojis) {
    const file = e.file || (e.url ? e.url.split("/").pop() : "")
    const src = e.url || emojiStaticUrl(emojiState.activeFolder, file)
    const cell = document.createElement("div")
    cell.className = "emoji-cell"
    cell.dataset.file = file
    cell.title = e.name || file
    cell.setAttribute("draggable", emojiState.selectMode ? "false" : "true")
    const img = document.createElement("img")
    img.src = src
    img.alt = e.name || file
    cell.appendChild(img)
    if (emojiState.selectMode) {
      // 勾选模式：右上角圆孔
      cell.classList.add("selectable")
      const chk = document.createElement("div")
      chk.className = "emoji-check" + (emojiState.selected.has(file) ? " checked" : "")
      chk.innerHTML = emojiState.selected.has(file) ? "✓" : ""
      cell.appendChild(chk)
      cell.classList.toggle("selected", emojiState.selected.has(file))
      // 点击 cell 或圆孔 -> 切换选中
      cell.addEventListener("click", () => toggleEmojiSelected(file))
      cell.addEventListener("contextmenu", (ev) => ev.preventDefault())
    } else {
      cell.addEventListener("click", () => insertEmojiToTarget(src))
      cell.addEventListener("dragstart", (ev) => onEmojiDragStart(ev, file, cell))
      cell.addEventListener("dragover", (ev) => onEmojiDragOver(ev, file, cell, "item"))
      cell.addEventListener("dragleave", () => cell.classList.remove("drag-target"))
      cell.addEventListener("drop", (ev) => onEmojiDrop(ev, file, cell))
      cell.addEventListener("contextmenu", (ev) => { ev.preventDefault(); showEmojiMenu(ev, file) })
    }
    grid.appendChild(cell)
  }
  // 勾选模式底部操作条
  toggleEmojiBatchBar()
}

// 切换表情勾选状态
function toggleEmojiSelected(file) {
  if (emojiState.selected.has(file)) emojiState.selected.delete(file)
  else emojiState.selected.add(file)
  // 仅更新对应 cell 圆孔，避免整页重渲染丢失滚动
  const cell = [...document.querySelectorAll(".emoji-cell")].find(c => c.dataset.file === file)
  if (cell) {
    const chk = cell.querySelector(".emoji-check")
    const on = emojiState.selected.has(file)
    cell.classList.toggle("selected", on)
    if (chk) { chk.classList.toggle("checked", on); chk.innerHTML = on ? "✓" : "" }
  }
  toggleEmojiBatchBar()
}

// 进入勾选模式（右键「选中」触发）
function enterEmojiSelectMode(file) {
  emojiState.selectMode = true
  emojiState.selected = new Set([file])
  renderEmojiGrid(emojiState.currentEmojis)
}

// 退出勾选模式
function exitEmojiSelectMode() {
  emojiState.selectMode = false
  emojiState.selected.clear()
  renderEmojiGrid(emojiState.currentEmojis)
  toggleEmojiBatchBar()
}

// 显示/隐藏底部批量操作条
function toggleEmojiBatchBar() {
  const bar = $("#emojiBatchBar")
  if (!bar) return
  if (emojiState.selectMode) {
    bar.style.display = "flex"
    const count = emojiState.selected.size
    $("#emojiBatchCount").textContent = count > 0 ? `已选 ${count} 张` : "未选择"
    $("#emojiBatchDelete").disabled = count === 0
  } else {
    bar.style.display = "none"
  }
}

// 批量删除勾选的表情
async function deleteSelectedEmojis() {
  const files = [...emojiState.selected]
  if (!files.length) return
  if (!confirm(`确定删除选中的 ${files.length} 张表情？`)) return
  try {
    for (const f of files) {
      await api(`/emoji/lists/${encodeURIComponent(emojiState.activeFolder)}/emojis/${encodeURIComponent(f)}`, { method: "DELETE" })
    }
    exitEmojiSelectMode()
    await loadEmojiGrid(emojiState.activeFolder)
    showToast(`已删除 ${files.length} 张表情`)
  } catch (e) {
    showToast("删除失败: " + e.message)
  }
}

// 将表情图片 URL 填入对应位置
async function insertEmojiToTarget(url) {
  if (emojiState.mode === "ark" && emojiState.arkTarget) {
    showToast("表情图片上传中...")
    try {
      const up = await uploadLocalImageForSend(url, "emoji.png")
      const input = document.getElementById(emojiState.arkTarget)
      if (input) input.value = up
    } catch (e) {
      showToast("表情图片上传失败: " + e.message)
    }
    closeEmojiPicker()
    return
  }
  // 编辑器模式：插入到光标处（普通/MD 共用 contenteditable）
  const editor = $("#chatInput")
  if (!editor) { closeEmojiPicker(); return }
  editor.focus()
  if (savedEditorRange) restoreEditorRange(savedEditorRange)
  const seg = document.createElement("img")
  seg.src = url
  seg.className = "chat-image-inline"
  seg.setAttribute("data-url", url)
  seg.setAttribute("data-type", "image")
  seg.contentEditable = "false"
  insertNodeAtCursor(seg)
  closeEmojiPicker()
}

// 插入图片节点到光标处（与普通图片粘贴逻辑一致）
function insertNodeAtCursor(node) {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) {
    $("#chatInput").appendChild(node)
    return
  }
  let range = savedEditorRange || sel.getRangeAt(0)
  range.deleteContents()
  const r = range.cloneRange()
  r.insertNode(node)
  r.setStartAfter(node)
  r.collapse(true)
  sel.removeAllRanges()
  sel.addRange(r)
  savedEditorRange = r.cloneRange()
}

function restoreEditorRange(range) {
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
}

// ===== 新建表情列表 =====
function openEmojiListCreate() {
  emojiState.createIconFile = null
  $("#emojiListCreatePreview").innerHTML = '<span class="emoji-default-icon">📁</span>'
  $("#emojiListCreateTitle").value = ""
  $("#emojiListCreateFolder").value = ""
  $("#emojiListCreateModal").style.display = "flex"
}

async function createEmojiList() {
  const title = $("#emojiListCreateTitle").value.trim()
  const folder = $("#emojiListCreateFolder").value.trim()
  if (!title && !folder) { showToast("请填写标题或文件夹名称"); return }
  try {
    const fd = new FormData()
    fd.append("title", title)
    fd.append("folder", folder)
    if (emojiState.createIconFile) fd.append("iconFile", emojiState.createIconFile, emojiState.createIconFile.name)
    const data = await api("/emoji/lists", { method: "POST", body: fd })
    $("#emojiListCreateModal").style.display = "none"
    await loadEmojiLists()
    if (data.list) {
      emojiState.activeFolder = data.list.folder
      renderEmojiListBar()
      await loadEmojiGrid(data.list.folder)
    }
  } catch (e) {
    showToast("创建失败: " + e.message)
  }
}

async function deleteEmojiList(folder) {
  if (!confirm(`确定删除表情列表「${emojiState.lists.find(l => l.folder === folder)?.title || folder}」及其所有表情？`)) return
  try {
    await api(`/emoji/lists/${encodeURIComponent(folder)}`, { method: "DELETE" })
    if (emojiState.activeFolder === folder) emojiState.activeFolder = null
    await loadEmojiLists()
  } catch (e) {
    showToast("删除失败: " + e.message)
  }
}

// ===== 添加表情图片（含 zip 压缩包 / 文件夹多文件）=====
function pickEmojiImages() {
  $("#emojiImageInput").value = ""
  $("#emojiImageInput").click()
}

async function addEmojiImages(fileList) {
  if (!emojiState.activeFolder) { showToast("请先选择或新建一个表情列表"); return }
  const fd = new FormData()
  for (const f of fileList) fd.append("files", f, f.name)
  try {
    const data = await api(`/emoji/lists/${encodeURIComponent(emojiState.activeFolder)}/emojis`, { method: "POST", body: fd })
    await loadEmojiGrid(emojiState.activeFolder)
    const added = (data.added || []).length
    const skipped = data.skipped || 0
    if (skipped > 0) showToast(`已添加 ${added} 张，跳过 ${skipped} 张重复图片`)
    else showToast(`已添加 ${added} 张表情`)
  } catch (e) {
    showToast("添加失败: " + e.message)
  }
}

async function deleteEmoji(folder, file) {
  if (!confirm("确定删除该表情？")) return
  try {
    await api(`/emoji/lists/${encodeURIComponent(folder)}/emojis/${encodeURIComponent(file)}`, { method: "DELETE" })
    await loadEmojiGrid(folder)
  } catch (e) {
    showToast("删除失败: " + e.message)
  }
}

// ===== 拖动排序（原生 HTML5 Drag & Drop，对标 imagebed：插入占位 + 拖到目标交换）=====
// 交换两个 DOM 节点位置（用占位注释节点，保证前后相邻都能正确交换）
function swapDomNodes(a, b) {
  if (!a || !b || a === b || a.parentNode !== b.parentNode) return
  const parent = a.parentNode
  const marker = document.createComment("swap")
  parent.insertBefore(marker, a)
  parent.insertBefore(a, b)
  parent.insertBefore(b, marker)
  parent.removeChild(marker)
}

// 列表拖拽
function onListDragStart(ev, folder, item) {
  emojiState.dragList = folder
  item.classList.add("dragging")
  ev.dataTransfer.effectAllowed = "move"
  try { ev.dataTransfer.setData("text/plain", folder) } catch (e) {}
}

// 根据光标在目标元素内的水平位置判断意图：
// 左 1/3 = 插到前面；右 1/3 = 插到后面；中间 1/3 = 交换位置
function dragIntent(ev, el) {
  const r = el.getBoundingClientRect()
  const x = ev.clientX - r.left
  if (x < r.width / 3) return "before"
  if (x > (r.width * 2) / 3) return "after"
  return "swap"
}

function onListDragOver(ev, folder, el) {
  ev.preventDefault()
  ev.dataTransfer.dropEffect = "move"
  if (folder === emojiState.dragList) return
  const intent = dragIntent(ev, el)
  el.classList.toggle("drag-target", intent === "swap")
  el.classList.toggle("drag-insert-before", intent === "before")
  el.classList.toggle("drag-insert-after", intent === "after")
}

async function onListDrop(ev, folder, el) {
  ev.preventDefault()
  const draggingFolder = emojiState.dragList
  const bar = $("#emojiListItems")
  const dragging = [...bar.querySelectorAll(".emoji-list-item")].find(e => e.dataset.folder === draggingFolder)
  if (!dragging || draggingFolder === folder) { cleanupListDnd(); return }
  const intent = dragIntent(ev, el)
  if (intent === "swap") {
    swapDomNodes(dragging, el)
  } else if (intent === "before") {
    bar.insertBefore(dragging, el)
  } else {
    // after：插到目标后面（即目标的下一个兄弟节点之前）
    const next = el.nextElementSibling
    if (next) bar.insertBefore(dragging, next)
    else bar.appendChild(dragging)
  }
  cleanupListDnd()
  const order = [...bar.querySelectorAll(".emoji-list-item")].map(e => e.dataset.folder)
  try {
    await api("/emoji/lists/reorder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order }) })
    emojiState.dragList = null
    await loadEmojiLists()
  } catch (e) { showToast("排序保存失败") }
}

function cleanupListDnd() {
  document.querySelectorAll(".emoji-list-item.dragging,.emoji-list-item.drag-target,.emoji-list-item.drag-insert-before,.emoji-list-item.drag-insert-after")
    .forEach(e => e.classList.remove("dragging", "drag-target", "drag-insert-before", "drag-insert-after"))
  emojiState.dragList = null
}

// 表情拖拽
function onEmojiDragStart(ev, file, cell) {
  emojiState.dragEmoji = file
  cell.classList.add("dragging")
  ev.dataTransfer.effectAllowed = "move"
  try { ev.dataTransfer.setData("text/plain", file) } catch (e) {}
}

function onEmojiDragOver(ev, file, el) {
  ev.preventDefault()
  ev.dataTransfer.dropEffect = "move"
  if (file === emojiState.dragEmoji) return
  const intent = dragIntent(ev, el)
  el.classList.toggle("drag-target", intent === "swap")
  el.classList.toggle("drag-insert-before", intent === "before")
  el.classList.toggle("drag-insert-after", intent === "after")
}

async function onEmojiDrop(ev, file, el) {
  ev.preventDefault()
  const draggingFile = emojiState.dragEmoji
  const grid = $("#emojiGrid")
  const dragging = [...grid.querySelectorAll(".emoji-cell")].find(c => c.dataset.file === draggingFile)
  if (!dragging || draggingFile === file) { cleanupEmojiDnd(); return }
  const intent = dragIntent(ev, el)
  if (intent === "swap") {
    swapDomNodes(dragging, el)
  } else if (intent === "before") {
    grid.insertBefore(dragging, el)
  } else {
    const next = el.nextElementSibling
    if (next) grid.insertBefore(dragging, next)
    else grid.appendChild(dragging)
  }
  cleanupEmojiDnd()
  const order = [...grid.querySelectorAll(".emoji-cell")].map(c => c.dataset.file)
  try {
    await api(`/emoji/lists/${encodeURIComponent(emojiState.activeFolder)}/emojis/reorder`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order }),
    })
    emojiState.dragEmoji = null
    await loadEmojiGrid(emojiState.activeFolder)
  } catch (e) { showToast("排序保存失败") }
}

function cleanupEmojiDnd() {
  document.querySelectorAll(".emoji-cell.dragging,.emoji-cell.drag-target,.emoji-cell.drag-insert-before,.emoji-cell.drag-insert-after")
    .forEach(e => e.classList.remove("dragging", "drag-target", "drag-insert-before", "drag-insert-after"))
  emojiState.dragEmoji = null
}

// ===== 右键菜单（表情包专用，动态生成）=====
function showEmojiContextMenu(ev, items) {
  closeEmojiContextMenu()
  const menu = document.createElement("div")
  menu.className = "context-menu emoji-context-menu"
  menu.id = "emojiContextMenu"
  menu.style.zIndex = "99999"
  const appendItem = (it) => {
    if (it.divider) {
      const d = document.createElement("div")
      d.className = "context-menu-divider"
      menu.appendChild(d)
      return
    }
    const el = document.createElement("div")
    el.className = "context-menu-item" + (it.danger ? " danger" : "")
    el.textContent = it.label
    el.addEventListener("click", () => { closeEmojiContextMenu(); it.onClick() })
    menu.appendChild(el)
  }
  for (const it of items) appendItem(it)
  // 挂载到表情包弹窗内部，避免被弹窗遮罩（z-index:600）盖住
  const host = document.getElementById("emojiPickerModal") || document.body
  host.appendChild(menu)
  // 定位（避免超出视口）
  const mw = menu.offsetWidth, mh = menu.offsetHeight
  let x = ev.clientX, y = ev.clientY
  if (x + mw > window.innerWidth) x = window.innerWidth - mw - 8
  if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8
  menu.style.left = x + "px"
  menu.style.top = y + "px"
  // 点击别处（非菜单内）关闭；用 pointerdown 捕获，且过滤菜单自身点击，避免右键事件冒泡误关
  setTimeout(() => {
    document.addEventListener("pointerdown", onEmojiMenuOutside, true)
  }, 0)
}

function onEmojiMenuOutside(e) {
  const m = document.getElementById("emojiContextMenu")
  if (m && !m.contains(e.target)) {
    closeEmojiContextMenu()
    document.removeEventListener("pointerdown", onEmojiMenuOutside, true)
  }
}

function closeEmojiContextMenu() {
  document.removeEventListener("pointerdown", onEmojiMenuOutside, true)
  const m = document.getElementById("emojiContextMenu")
  if (m) m.remove()
}

// 列表右键菜单：修改设置 / 删除
function showEmojiListMenu(ev, list) {
  showEmojiContextMenu(ev, [
    { label: "修改设置", onClick: () => openEmojiListEdit(list) },
    { divider: true },
    { label: "删除列表", danger: true, onClick: () => deleteEmojiList(list.folder) },
  ])
}

// 表情右键菜单：选中 / 删除
function showEmojiMenu(ev, file) {
  showEmojiContextMenu(ev, [
    { label: "选中", onClick: () => enterEmojiSelectMode(file) },
    { divider: true },
    { label: "删除", danger: true, onClick: () => deleteEmoji(emojiState.activeFolder, file) },
  ])
}

// ===== 修改表情列表设置弹窗 =====
function openEmojiListEdit(list) {
  emojiState.editFolder = list.folder
  emojiState.editIconFile = null
  $("#emojiListEditTitle").value = list.title || ""
  const preview = $("#emojiListEditPreview")
  if (list.icon) {
    preview.innerHTML = list.icon.includes(".")
      ? `<img src="${emojiStaticUrl("icon", list.icon)}" alt="">`
      : (list.icon || `<span class="emoji-default-icon">📁</span>`)
  } else {
    preview.innerHTML = `<span class="emoji-default-icon">📁</span>`
  }
  $("#emojiListEditModal").style.display = "flex"
}

async function saveEmojiListEdit() {
  const folder = emojiState.editFolder
  if (!folder) return
  const title = $("#emojiListEditTitle").value.trim()
  try {
    const fd = new FormData()
    if (title) fd.append("title", title)
    if (emojiState.editIconFile) fd.append("iconFile", emojiState.editIconFile, emojiState.editIconFile.name)
    await api(`/emoji/lists/${encodeURIComponent(folder)}`, { method: "PATCH", body: fd })
    $("#emojiListEditModal").style.display = "none"
    await loadEmojiLists()
    if (emojiState.activeFolder === folder) await loadEmojiGrid(folder)
    showToast("已保存列表设置")
  } catch (e) {
    showToast("保存失败: " + e.message)
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}

// 表情包弹窗事件绑定
function bindEmojiPickerEvents() {
  $("#emojiPickerClose").addEventListener("click", closeEmojiPicker)
  $("#emojiListAdd").addEventListener("click", openEmojiListCreate)
  $("#emojiImageInput").addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length) addEmojiImages([...e.target.files])
  })
  $("#emojiPickerModal").addEventListener("click", (e) => {
    if (e.target === $("#emojiPickerModal")) closeEmojiPicker()
  })
  // 新建列表弹窗
  $("#emojiListCreateClose").addEventListener("click", () => $("#emojiListCreateModal").style.display = "none")
  $("#emojiListCreateConfirm").addEventListener("click", createEmojiList)
  $("#emojiListCreatePickIcon").addEventListener("click", () => $("#emojiListCreateIconFile").click())
  $("#emojiListCreateIconFile").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    emojiState.createIconFile = file
    const url = URL.createObjectURL(file)
    $("#emojiListCreatePreview").innerHTML = `<img src="${url}" alt="icon">`
  })
  $("#emojiListCreateModal").addEventListener("click", (e) => {
    if (e.target === $("#emojiListCreateModal")) $("#emojiListCreateModal").style.display = "none"
  })
  // 修改列表设置弹窗
  $("#emojiListEditClose").addEventListener("click", () => $("#emojiListEditModal").style.display = "none")
  $("#emojiListEditConfirm").addEventListener("click", saveEmojiListEdit)
  $("#emojiListEditPickIcon").addEventListener("click", () => $("#emojiListEditIconFile").click())
  $("#emojiListEditIconFile").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    emojiState.editIconFile = file
    const url = URL.createObjectURL(file)
    $("#emojiListEditPreview").innerHTML = `<img src="${url}" alt="icon">`
  })
  $("#emojiListEditModal").addEventListener("click", (e) => {
    if (e.target === $("#emojiListEditModal")) $("#emojiListEditModal").style.display = "none"
  })
  // 批量操作条
  $("#emojiBatchCancel").addEventListener("click", exitEmojiSelectMode)
  $("#emojiBatchDelete").addEventListener("click", deleteSelectedEmojis)
  // 操作提示面板：锚定在标题栏下方（CSS absolute，约束在弹窗内）
  const helpBtn = $("#emojiHelpBtn")
  const helpPanel = $("#emojiHelpPanel")
  function showHelp() {
    helpPanel.style.display = "block"
  }
  function hideHelp() {
    const p = $("#emojiHelpPanel")
    if (p && !p.matches(":hover") && document.activeElement !== helpBtn) p.style.display = "none"
  }
  helpBtn.addEventListener("click", (e) => {
    e.stopPropagation()
    if (helpPanel.style.display === "block") helpPanel.style.display = "none"
    else showHelp()
  })
  helpBtn.addEventListener("mouseenter", showHelp)
  helpBtn.addEventListener("mouseleave", () => setTimeout(hideHelp, 150))
  helpPanel.addEventListener("mouseleave", () => setTimeout(hideHelp, 150))
}

document.addEventListener("DOMContentLoaded", init)
