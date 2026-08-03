# QQBot-Web-Adapter

为 QQBot 基于 [TRSS-Yunzai] 提供 Web 管理控制台，支持浏览器管理 QQ 机器人。

使用本适配器首先请安装我的自用版 [QQBot-Plugin](https://gitee.com/wind-trace-typ/Yunzai-QQBot-Plugin)，这样才能正常使用此功能。

本插件消息记录功能支持 **Redis**（默认）和 **SQLite** 两种存储后端，可按需切换。有任何 bug 可提 issue 或加入 [@windtrace/qq-group-bot](https://qm.qq.com/q/LXwq9hplKu) 本群讨论。

此外若是安装了我的[全量群记录](https://gitee.com/wind-trace-typ/full-group-record)这个插件，可以首先找到 `plugins/example/全量记录.js` 删除，再安装本插件（功能重复，不删除也不影响）。

## 特性

- **多 Bot 管理** — 切换查看不同 Bot 的群聊、私聊
- **群聊管理** — 查看群列表、群成员、群消息历史，发送/撤回群消息
- **私聊管理** — 查看私聊用户列表、私聊消息，发送/撤回私聊消息
- **实时推送** — WebSocket 实时接收新消息
- **消息记录** — 自动记录群消息/私聊，支持 Redis / SQLite 双后端（可开关）
- **媒体缓存** — 自动下载图片/视频到本地，MD5 去重（可开关，上限可配）
- **登录鉴权** — 用户名/密码登录，24 小时 Session，支持验证码与失败封禁
- **系统信息** — 面板显示 CPU、内存、磁盘、系统版本、Node 版本
- **在线配置** — 通过面板修改配置，敏感改动需验证码
- **角色显示** — 群消息显示群主/管理员身份徽章
- **黑名单管理** — 可以直接在线添加/删除黑名单用户
- **登录bot** — 可以直接在web端使用appid登录bot或者通过扫码登录bot
- **通知推送** — 可以将变更设置、验证码、登录失败等通知推送到指定用户的私聊
- **聊天记录解析** — 可以将聊天记录解析成卡片的格式，点击可查阅内容
- **自定义页面** — 支持开发者自定义页面开发，可自行安排页面内容，页面均可在web端侧边栏访问，支持自定义api（自带web鉴权），具体参考[🔗page.md](https://gitee.com/wind-trace-typ/QQBot-Web-Adapter/blob/master/page.md)

## 安装

在 Yunzai 的根目录下执行以下命令安装本插件：

#### Gitee 链接（当前安装需要登录）：
```bash
git clone https://gitee.com/wind-trace-typ/QQBot-Web-Adapter.git ./plugins/QQBot-Web-Adapter
```
#### Gitcode 链接（可直接安装）:
```bash
git clone https://gitcode.com/wind-trace/QQBot-Web-Adapter.git ./plugins/QQBot-Web-Adapter
```

在 Yunzai 的根目录下执行以下命令安装本插件所需要的依赖：
```bash
pnpm i
```

## 依赖

| 依赖 | 说明 |
|------|------|
| **QQBot-Plugin** | 核心依赖，提供 Bot 实例、Express 服务、消息记录等 |
| **Redis** | 由 Yunzai 提供，用于消息存储（默认后端）与 Session 管理 |
| **SQLite3** | 由 Yunzai 提供，可选存储后端，无需额外服务，数据存于 `data/db/messages.db` |
| **fastfetch** | 用于获取系统信息（非刚需，自行决定是否安装） |
| **qrcode** | 用于扫码登录显示二维码（非刚需） |

> 本插件无需单独安装 npm 依赖，复用 Yunzai 框架已有的 express、yaml、redis、sequelize、sqlite3 等包。

## 访问

安装并启动后，浏览器访问（端口及 IP 取决于框架配置，默认 2536，一般可以直接使用开机插件载入日志里的地址访问）：

```
http://127.0.0.1:2536/qqbot-web/
```

若已在 `Yunzai/config/config/server.yaml` 中设置了 HTTPS 服务器及可用证书：

```
https://域名:https服务器端口/qqbot-web/
```

## 配置

配置文件位于 `config/config.yaml`，安装后自动生成：

```yaml
# Web 控制台 URL 路径前缀
basePath: qqbot-web

# 消息记录开关（关闭后不记录消息及活跃群，建议保持开启）
autoRecordMessage: true

# 图片/视频本地缓存开关（开启后自动下载到 data/imgs/ 并 MD5 去重）
autoDownloadImgorVideo: true

# 媒体缓存大小上限（MB），范围 1-100
maxMediaCacheSize: 10

# 记录保留天数，可选 1~7
saveTimes: 3

# 消息存储后端，可选 redis（默认）或 sqlite
# sqlite 无需额外服务，数据存储在 QQBot-Plugin/data/db/messages.db
# 切换后新消息存入新后端，旧数据不受影响，修改后立即生效
storageBackend: redis

# 登录鉴权
login:
  enabled: true          # 是否开启登录验证
  username: admin        # 用户名
  password: admin123     # 密码

# 配置变更通知目标用户 ID（格式：openid）
notifyUserId: ""

# 是否在全量群列表中启用 QQBot 指令（如 #设置备注 等）
enableQuanliangCommands: true
```

> 配置可通过 Web 面板在线修改，无需手动编辑文件。

## Nginx 反向代理

如果使用 nginx 反代并启用 HTTPS，需要配置 WebSocket 支持，否则消息实时推送功能会失效（浏览器控制台会显示 `WebSocket connection ... failed`）。

在 `location /` 块中**至少需要**加入以下三行：

```nginx
location / {
    proxy_pass http://localhost:2536;
    proxy_http_version 1.1;                  # WebSocket 必须 HTTP/1.1
    proxy_set_header Upgrade $http_upgrade;   # 转发 WebSocket 升级请求
    proxy_set_header Connection "upgrade";    # 维持升级连接
    # ... 其他配置保持不变
}
```

> `proxy_http_version 1.1` 不可省略，nginx 默认使用 HTTP/1.0 与后端通信，WebSocket 握手需要 1.1。

## 文件结构

```
QQBot-Web-Adapter/
├── index.js           # 主入口，全部后端逻辑
├── config/
│   └── config.yaml    # 配置文件
├── web/
│   ├── index.html     # 控制台页面
│   ├── login.html     # 登录页面
│   ├── app.js         # 前端 SPA 应用
│   └── style.css      # 样式
└── README.md
```

## 使用建议

1. 建议不要在 `QQBot-Web-Adapter/config/config.yaml` 中手动修改配置，使用 Web 面板修改。
2. 第一次登录后立即修改用户名密码配置以及通知设置。
3. 消息记录开关建议打开，图片视频缓存开关按需开启，记录保存天数小 bot 建议 7 天，大 bot 建议 3 天。
4. 如果服务器没有 Redis 或不想额外部署，可将 `storageBackend` 设为 `sqlite`，无需额外服务。
5. 及时给自己的群聊设置备注方便使用。
6. 发送动图变静态图时，请将 `Yunzai/config/QQBot.yaml` 中的 `imageLength` 值调大（单位为 MB，超过此大小的图片会被压缩）。
7. 如果只需要在内网访问可将设置中`公网访问开关`关闭。
8. 如果需要自定义页面且需要注册自定义的api，请使用插件提供的方法注册api，这样自带鉴权，防止漏洞，若是需要注册可以访问或修改本地文件的api，请自行添加各类防护如防止路径穿越以及各类危险字符等。

## 交流群

[@windtrace/qq-group-bot](https://qm.qq.com/q/LXwq9hplKu)
