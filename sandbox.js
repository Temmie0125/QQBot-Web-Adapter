/**
 * QQBot 沙盒 Adapter
 * 用法同 plugins/adapter/stdin.js：注册一个虚拟 adapter 进 Bot.adapter，
 * 在沙盒页面里「发送用户消息 / 触发通知」会 emit 与真实 QQBot 一致的事件
 * （qqbot_msg / qqbot_private_msg / qqbot_notice），从而正常触发插件；
 * 插件的回复通过本 adapter 的 sendMsg 再以 qqbot_msg 事件回流到沙盒页面显示。
 *
 * 事件名与 QQBot-Plugin 一致，因此所有监听这些事件的插件（含 WebAdapter 的
 * WebSocket 实时推送）都会像处理真实消息一样处理沙盒消息。
 */

import path from "node:path"
import { fileURLToPath } from "node:url"

const SANDBOX_ID = "QQBotSandbox"
const SEP = ":"
// 沙盒 bot 头像：取本插件目录下的 webadapter/public/bot.png，拼成文件系统绝对本地路径。
const __sandboxDir = path.dirname(fileURLToPath(import.meta.url))
const BOT_AVATAR = path.join(__sandboxDir, "webadapter", "public", "bot.png")

// 默认占位 ID（32 位 F，避免与真实 ID 冲突）
const FF =
  "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
const FF_USER = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFE"

// 把 openid 归一为 self_id 前缀格式
function fullGroupId(gid) {
  return gid.startsWith(`${SANDBOX_ID}${SEP}`) ? gid : `${SANDBOX_ID}${SEP}${gid}`
}
function fullUserId(uid) {
  return uid.startsWith(`${SANDBOX_ID}${SEP}`) ? uid : `${SANDBOX_ID}${SEP}${uid}`
}

// 真实 QQBot 事件里的 message 段需要是 segment 数组
function toSegs(text, image, at) {
  const segs = []
  if (image) {
    segs.push({ type: "image", file: image })
    if (text) segs.push({ type: "text", text })
  } else {
    segs.push({ type: "text", text: text || "" })
  }
  if (at) segs.push({ type: "at", qq: at })
  return segs
}

// 沙盒专用 WebSocket（独立通道，免去主 WS 的登录鉴权依赖）：连接到 /qqbot-sandbox-ws
const sandboxConns = new Set()
// 轮询兜底：WS 不可用时，bot 回复先入 outbox，页面定时拉取（避免依赖 WS 连通性）
function sbBroadcast(type, payload, outbox) {
  const msg = JSON.stringify({ type, ...payload })
  for (const conn of sandboxConns) {
    try { conn.sendMsg(msg) } catch {}
  }
  // 同时写入 outbox，供页面轮询兜底
  if ((type === "new_message" || type === "new_private_message") && outbox) {
    outbox.push({ type, ...payload })
  }
}

Bot.adapter.push(
  new (class QQBotSandboxAdapter {
    id = SANDBOX_ID
    name = "QQBot 沙盒"
    path = "data/QQBotSandbox/"
    sep = SEP
    version = "sandbox v0.0.1"
    // 轮询兜底队列：bot 回复先入此处，页面定时拉取
    sandboxOutbox = []

    // 沙盒统一使用固定的占位 ID（页面可传参覆盖）
    defaultGroupId = FF
    defaultUserId = FF_USER
    defaultUserName = "测试用户"
    defaultGroupName = "沙盒测试群"

    async sendMsg(msg) {
      if (!Array.isArray(msg)) msg = [msg]
      const data = this._lastData || {}
      // 插件回复回流：以 [Bot] 身份 emit 一个 qqbot_msg 事件
      const isPrivate = !!data.message_type && data.message_type !== "group"
      const evt = {
        self_id: SANDBOX_ID,
        user_id: data.user_id || fullUserId(this.defaultUserId),
        group_id: data.group_id || fullGroupId(this.defaultGroupId),
        message_type: data.message_type || "group",
        post_type: "message",
        sub_type: "create",
        nickname: "QQBot测试助手",
        raw_message: msg
          .map(s => (s.text ? s.text : s.type === "image" ? "[图片]" : `[${s.type}]`))
          .join(" "),
        message: msg.map(s =>
          s.type === "image"
            ? { type: "image", file: s.file, url: s.file }
            : s,
        ),
        message_id: `${SANDBOX_ID}-${Date.now().toString(36)}`,
        timestamp: Date.now() / 1000,
        me: true,
        is_bot: true,
        // 提供 raw_event.author.bot，使 WebAdapter 的 eventToMessage 保留 is_bot 标记
        raw_event: { d: { author: { bot: true } } },
        from_sandbox: true,
      }
      // 让 WebAdapter 的 wsBroadcast 把这条 bot 回复推给正在 watch 沙盒的页面
      if (isPrivate) {
        Bot.em("qqbot_private_msg", evt)
        sbBroadcast("new_private_message", { privateUserId: evt.user_id, message: evt }, this.sandboxOutbox)
      } else {
        Bot.em("qqbot_msg", evt)
        sbBroadcast("new_message", { groupId: evt.group_id, message: evt }, this.sandboxOutbox)
      }
      // 兼容真实 QQBot SDK 的返回结构（插件常读 msgRes.data[0].ext_info.ref_idx）
      return {
        message_id: evt.message_id,
        data: [{ ext_info: { ref_idx: evt.message_id } }],
      }
    }

    recallMsg(message_id) {
      Bot.makeLog("info", `沙盒撤回消息: ${message_id}`, this.id)
    }

    pickFriend(id, user_id) {
      const uid = fullUserId(user_id || this.defaultUserId)
      const i = {
        ...Bot[id].fl.get(uid),
        self_id: id,
        bot: Bot[id],
        user_id: uid.replace(`${id}${SEP}`, ""),
        platform: "QQ-private",
        message_type: "private",
      }
      const appid = (Bot[id] && Bot[id].info && Bot[id].info.appid) || "sandbox"
      return {
        ...i,
        sendMsg: msg => this.sendMsg(msg),
        recallMsg: mid => this.recallMsg(mid),
        // 与真实 QQBot-Plugin 一致：提供头像 URL（沙盒用占位 appid）
        getAvatarUrl: () => `https://q.qlogo.cn/qqapp/${appid}/${i.user_id}/0`,
        getFriendInfo: () => i,
      }
    }

    pickMember(id, group_id, user_id) {
      const gid = fullGroupId(group_id || this.defaultGroupId)
      const uid = fullUserId(user_id || this.defaultUserId)
      const appid = (Bot[id] && Bot[id].info && Bot[id].info.appid) || "sandbox"
      const base = {
        ...Bot[id].gml.get(gid)?.get(uid),
        self_id: id,
        bot: Bot[id],
        group_id: gid.replace(`${id}${SEP}`, ""),
        user_id: uid.replace(`${id}${SEP}`, ""),
        platform: "QQ-group-member",
        sendMsg: msg => this.sendMsg(msg),
        recallMsg: mid => this.recallMsg(mid),
        // 与真实 QQBot-Plugin 一致：补齐群成员常用方法，避免插件调用时报错
        getAvatarUrl: () => `https://q.qlogo.cn/qqapp/${appid}/${uid.replace(`${id}${SEP}`, "")}/0`,
        getGroupMemberInfo: () => ({}),
        kickGroupMember: () => Promise.resolve(),
        muteGroupMember: () => Promise.resolve(),
        unmuteGroupMember: () => Promise.resolve(),
        mute: () => Promise.resolve(),
        getFriendInfo: () => ({}),
      }
      return Object.assign({}, this.pickFriend(id, uid), base)
    }

    pickGroup(id, group_id) {
      const gid = fullGroupId(group_id || this.defaultGroupId)
      const i = {
        ...Bot[id].gl.get(gid),
        self_id: id,
        bot: Bot[id],
        group_id: gid.replace(`${id}${SEP}`, ""),
        platform: "QQ-group",
        message_type: "group",
      }
      return {
        ...i,
        sendMsg: msg => this.sendMsg(msg),
        recallMsg: mid => this.recallMsg(mid),
        pickMember: user_id => this.pickMember(id, gid, user_id),
      }
    }

    /** 沙盒页面调用：发送一条用户消息，触发插件 */
    message(opts) {
      const gid = fullGroupId(opts.groupId || this.defaultGroupId)
      const uid = fullUserId(opts.userId || this.defaultUserId)
      const isPrivate = !!opts.private
      const segs = toSegs(opts.text, opts.image, opts.at)
      const raw =
        (opts.image ? "[图片] " : "") + (opts.text || "") +
        (opts.at ? ` <@${opts.at}>` : "")
      const data = {
        self_id: SANDBOX_ID,
        user_id: uid,
        group_id: gid,
        post_type: "message",
        message_type: isPrivate ? "private" : "group",
        sub_type: "create",
        nickname: opts.userName || this.defaultUserName,
        avatar: "",
        message: segs,
        raw_message: raw,
        message_id: `${SANDBOX_ID}-in-${Date.now().toString(36)}`,
        timestamp: Date.now() / 1000,
        me: false,
        is_bot: false,
        event_id: `SANDBOX-${Date.now().toString(36)}`,
        from_sandbox: true,
      }
      // 记录最后一次上下文，sendMsg 回流时用
      this._lastData = {
        user_id: uid,
        group_id: gid,
        message_type: isPrivate ? "private" : "group",
      }
      // 为插件回复提供 reply / sendMsg 入口（与真实 QQBot 事件一致）
      const target = isPrivate ? this.pickFriend(SANDBOX_ID, uid) : this.pickGroup(SANDBOX_ID, gid)
      data.bot = Bot[SANDBOX_ID]._botView || Bot[SANDBOX_ID]
      data.reply = msg => target.sendMsg(msg)
      data.sendMsg = msg => target.sendMsg(msg)
      data.recallMsg = mid => this.recallMsg(mid)
      Bot.makeLog("info", `沙盒系统消息: ${data.raw_message}`, this.id)
      // 同时下发标准 Yunzai 事件（message.group.create / message.private.create），
      // 与真实 QQBot（makeMessage 末尾 Bot.em）一致，命令插件据此触发
      Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
      if (isPrivate) Bot.em("qqbot_private_msg", data)
      else Bot.em("qqbot_msg", data)
      return data
    }

    /** 沙盒页面调用：触发一条系统通知（模拟 QQBot 真实可接收的 notice 事件）
     * 事件结构与 QQBot-Plugin.makeNotice 对齐：emit notice.{notice_type}.{sub_type}
     * （Yunzai 插件据此触发），同时 emit qqbot_notice（WebAdapter WS 推送）。 */
    notice(opts) {
      const gid = fullGroupId(opts.groupId || this.defaultGroupId)
      const uid = fullUserId(opts.userId || this.defaultUserId)
      const operatorId = opts.operatorId || opts.userId || this.defaultUserId
      const noticeType = opts.noticeType || "group"
      const subType = opts.subType || "increase"
      const userName = opts.userName || this.defaultUserName
      const appid = (this.id && Bot[this.id] && Bot[this.id].info && Bot[this.id].info.appid) || "sandbox"
      // 对齐 QQBot-Plugin.makeNotice 的真实结构：
      // - sender.user_id 为带 self_id 前缀的格式（openid 为裸值）
      // - adapter_id 强制为 "QQBot"，使仅在官机下生效的插件逻辑（入群欢迎/退群/加群申请/禁言等）正常触发
      // - 补齐 openid / unionid / operator_id / raw / raw_event / platform 等字段
      const sender = {
        user_id: uid,
        openid: operatorId,
        unionid: opts.unionid || "",
        nickname: userName,
        avatar: `https://q.qlogo.cn/qqapp/${appid}/${operatorId}/0`,
        bot: false,
      }
      const notice = {
        self_id: SANDBOX_ID,
        adapter_id: "QQBot",
        sender,
        get openid() { return sender.openid },
        get unionid() { return sender.unionid },
        get user_id() { return sender.user_id },
        set user_id(v) { sender.user_id = v },
        get nickname() { return sender.nickname },
        get avatar() { return sender.avatar },
        set avatar(v) { sender.avatar = v },
        bot: Bot[SANDBOX_ID]._botView || Bot[SANDBOX_ID],
        raw: opts.raw || null,
        raw_event: opts.raw || null,
        post_type: "notice",
        notice_type: noticeType,
        sub_type: subType,
        notice_id: `SANDBOX-NOTICE-${Date.now().toString(36)}`,
        event_id: `SANDBOX-NOTICE-${Date.now().toString(36)}`,
        platform: "QQ-notice",
        time: Math.floor(Date.now() / 1000),
        timestamp: Date.now() / 1000,
        operator_id: operatorId,
        nickname: userName,
        text: opts.text || "",
        from_sandbox: true,
      }
      // 群相关字段
      if (noticeType === "group") {
        notice.group_id = gid
        notice.group_name = opts.groupName || this.defaultGroupName
      }
      // 好友相关字段
      if (noticeType === "friend") {
        notice.user_id = uid
      }
      // 加群/加好友申请
      if (subType === "request") {
        notice.apply_source = opts.applySource || "group"
        notice.invited_by = opts.invitedBy || ""
        notice.verify_info = opts.verifyInfo || ""
        notice.join_request_id = opts.joinRequestId || `SANDBOX-REQ-${Date.now().toString(36)}`
      }
      Bot.makeLog("info", `沙盒通知: ${noticeType}.${subType} ${notice.text}`, this.id)
      // 与真实 QQBot 一致：级联 emit notice.{notice_type}.{sub_type}（插件据此触发）
      Bot.em(`notice.${noticeType}.${subType}`, notice)
      Bot.em("qqbot_notice", notice)
      return notice
    }

    async load() {
      // 构造一个最小可用的 Bot 实例，供插件 pickGroup / pickFriend 使用
      Bot[SANDBOX_ID] = {
        adapter: this,
        uin: SANDBOX_ID,
        nickname: this.name,
        avatar: BOT_AVATAR,
        info: { id: SANDBOX_ID, username: this.name, appid: "sandbox", avatar: BOT_AVATAR },
        version: { id: this.id, name: this.name, version: this.version },
        stat: { start_time: Date.now() / 1000 },
        fl: new Map(),
        gl: new Map(),
        gml: new Map(),
        pickFriend: user_id => this.pickFriend(SANDBOX_ID, user_id),
        get pickUser() {
          return this.pickFriend
        },
        pickMember: (group_id, user_id) =>
          this.pickMember(SANDBOX_ID, group_id, user_id),
        pickGroup: group_id => this.pickGroup(SANDBOX_ID, group_id),
      }
      // 预置一条群 + 一个用户 + 一个成员，避免插件读取 gl/fl 时报错
      Bot[SANDBOX_ID].gl.set(fullGroupId(this.defaultGroupId), {
        group_id: fullGroupId(this.defaultGroupId),
        group_name: this.defaultGroupName,
      })
      Bot[SANDBOX_ID].fl.set(fullUserId(this.defaultUserId), {
        user_id: fullUserId(this.defaultUserId),
        nickname: this.defaultUserName,
      })
      const gml = new Map()
      gml.set(fullUserId(this.defaultUserId), {
        user_id: fullUserId(this.defaultUserId),
        nickname: this.defaultUserName,
        group_id: fullGroupId(this.defaultGroupId),
      })
      Bot[SANDBOX_ID].gml.set(fullGroupId(this.defaultGroupId), gml)

      // 关键：将沙盒虚拟 bot 也注册进 Yunzai 的 bot 注册表（Bot.bots），
      // 否则 Yunzai 的 prepareEvent(data) 会因 this.bots[data.self_id] 不存在而提前
      // return，导致 e.bot / e.group / e.friend / e.reply 等核心字段缺失，命令插件
      // 虽能收到 message 事件但无法正常执行（表现为“插件不响应”）。
      Bot.bots[SANDBOX_ID] = Bot[SANDBOX_ID]

      // 供插件识别的 bot 视图：adapter.id 伪装为 "QQBot"（与真实 QQBot 一致），
      // 使以 e.bot.adapter.id === "QQBot" 为门槛的插件也能在沙盒中正常触发；
      // 真实 adapter.id 仍为 "QQBotSandbox"（API 仍按此查找本 adapter）。
      const botView = Object.create(Bot[SANDBOX_ID])
      Object.defineProperty(botView, "adapter", {
        configurable: true,
        value: Object.assign(Object.create(this), { id: "QQBot" }),
      })
      Bot[SANDBOX_ID]._botView = botView

      // 让沙盒默认群被视为“全量群”，使依赖 Bot.quanliangMap 的 notice 逻辑
      // （入群申请通知、退群通知等）在沙盒中也能正常触发。self_id 为独立的
      // QQBotSandbox 命名空间，不会与真实全量群数据冲突。
      if (!Bot.quanliangMap) Bot.quanliangMap = new Map()
      let ql = Bot.quanliangMap.get(SANDBOX_ID)
      if (!ql) { ql = new Set(); Bot.quanliangMap.set(SANDBOX_ID, ql) }
      ql.add(fullGroupId(this.defaultGroupId))

      // 注册沙盒专用 WebSocket：独立通道，无需登录鉴权，专供沙盒页面接收 bot 回复
      if (Bot.wsf) {
        Bot.wsf["qqbot-sandbox-ws"] = [
          (conn, req) => {
            conn.sendMsg = msg => {
              if (!Buffer.isBuffer(msg)) msg = String(msg)
              try { return conn.send(msg) } catch {}
            }
            sandboxConns.add(conn)
            conn.on("message", raw => {
              try {
                const m = JSON.parse(raw.toString())
                // 客户端可发送 watch 订阅（本沙盒仅一个频道，收到即全量推送，保留兼容）
                if (m.type === "watch" || m.type === "unwatch") { /* no-op，全量广播 */ }
              } catch {}
            })
            conn.on("close", () => sandboxConns.delete(conn))
            conn.on("error", () => sandboxConns.delete(conn))
          },
        ]
      }

      Bot.makeLog("mark", `${this.name}(${this.id}) 沙盒已就绪`, this.id)
      Bot.em(`connect.${SANDBOX_ID}`, { self_id: SANDBOX_ID })
    }
  })(),
)
