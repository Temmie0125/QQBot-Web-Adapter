# 自定义页面写法（WebAdapter 扩展控制台）

QQBot-Web-Adapter 支持在不改动插件主入口的情况下，给 Web 控制台新增自定义页面。
页面会出现在左侧导航栏，统一通过插件下的 **`webadapter/index.js` 操作模块** 扩展：

> **目录约定（重要）**：这里的 `webadapter/` 指的是**你自己的插件目录**下的子目录，即
> `plugins/<你的插件名>/webadapter/`。例如插件 `replaceButton-plugin` 就放在
> `plugins/replaceButton-plugin/webadapter/index.js`，插件 `my-plugin` 就放在
> `plugins/my-plugin/webadapter/index.js`。**不是**放在 QQBot-Web-Adapter 插件目录里，
> 也不是全局任意位置。WebAdapter 开机时会自动扫描 `plugins/*/webadapter/` 并加载其中的 `index.js`。

- 在 `webadapter/index.js` 中 `export function init(ctx)`，用 `ctx.registerPage(...)` 注册页面，
  用 `ctx.registerApi(...)` 注册页面所需的数据接口（自动带登录鉴权）。
- 若只是纯静态展示页，可用更轻量的「约定式」`webadapter/page.{js,json}`（或 `pages.{js,json}`）
  只导出页面描述符，无需写 `init`。

> WebAdapter 会在开机以及 `login` / `plugins/loaded` 事件时自动发现并调用各插件的
> `webadapter/index.js`，**插件主入口 `index.js` 无需任何改动**。

> **鉴权（重要）**：所有 `/api/*` 请求（含各插件操作模块注册的接口）都会被 WebAdapter 强制加上
> 公网限制 + 登录鉴权。请务必用 `ctx.registerApi` 注册接口（或自行 `Bot.express` 注册后
> `app.use(requireAuth)`），不要裸注册 `Bot.express.get(...)`。

---

## 一、描述符字段

一个页面描述符（`descriptor`）是一个对象，支持以下字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 页面唯一标识，仅允许 `^[A-Za-z0-9_-]+$`，如 `my-page`。重复会被覆盖。 |
| `title` | ✅ | 导航栏显示的标题。 |
| `icon` | ❌ | 导航栏图标，任意 emoji，默认 `📄`。 |
| `html` | ⚠️ | 直接注入的 HTML 片段（纯静态页）。与 `src` 二选一。 |
| `src` | ⚠️ | 指向 `webadapter/` 下的 HTML 文件，以 `<iframe>` 嵌入。与 `html` 二选一。 |
| `style` | ❌ | `webadapter/` 下的 css 文件，注入时按需加载。 |
| `script` | ❌ | `webadapter/` 下的 js 文件，注入时按需加载。 |
| `priority` | ❌ | 排序优先级，数值越小越靠前，默认 `100`。 |

- 同时提供 `html` 和 `src` 时，`src` 优先（`iframe` 模式）。
- `src` / `style` / `script` 里写的是相对 `webadapter/` 目录的文件名（如 `"dash.html"`），不要写绝对路径或 `../`。

---

## 二、约定式：纯静态页面快捷方式（page.json / pages.json）

适合**不需要后端接口**的纯展示页。在插件目录下直接放描述符文件，WebAdapter 开机自动扫描，
无需写 `init`。

> 注意：约定式只能注册「页面」本身，不能注册数据接口。若页面需要后端数据，
> 请用下方「三、操作模块注册」的方式写 `webadapter/index.js`。

### 示例 1：纯静态片段（`webadapter/page.json`）

```json
{
  "id": "hello",
  "title": "你好页",
  "icon": "👋",
  "html": "<h2>你好，这是自定义页面</h2><p>这段 HTML 会直接注入到页面中。</p>"
}
```

### 示例 2：iframe 嵌入独立 HTML（`webadapter/page.json` + `webadapter/dash.html`）

```json
{
  "id": "dashboard",
  "title": "仪表盘",
  "icon": "📊",
  "src": "dash.html",
  "style": "dash.css"
}
```

`webadapter/dash.html` 是一个完整的 HTML 页面，通过 iframe 嵌入：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>仪表盘</title>
  <link rel="stylesheet" href="dash.css" />
</head>
<body>
  <h2>我的仪表盘</h2>
  <button id="btn">点我</button>
  <script src="dash.js"></script>
</body>
</html>
```

> 提示：`iframe` 内的页面由浏览器从 `/qqbot-web/api/web-page/<插件名>/<文件>` 加载，
> 自带全局登录鉴权，无需自己处理登录。

### 示例 3：导出多个页面（`webadapter/pages.js`）

```js
export default [
  { id: "page-a", title: "页面 A", icon: "🅰️", html: "<p>A</p>", priority: 10 },
  { id: "page-b", title: "页面 B", icon: "🅱️", src: "b.html", priority: 20 }
]
```

也可以用 `export default { pages: [...] }` 的形式。`.json` 同理用数组或 `{ "pages": [...] }`。

---

## 三、操作模块注册（推荐：页面 + 接口一起）

新增一个 **`webadapter/index.js`**，导出 `init(ctx)`，即可在同一个地方注册页面和它所需的接口。
这是自定义页面（尤其带数据的页面）的**推荐写法**：

```js
import { Bot } from "yunzai"

export function init(ctx) {
  const { pluginName, registerPage, registerApi } = ctx

  // 1) 注册页面（ctx.registerPage 第一个参数就是插件名，已自动填好）
  registerPage({
    id: "my-page",
    title: "我的页面",
    icon: "⚙️",
    src: "dash.html",      // 指向 webadapter/ 下的 HTML（iframe 嵌入）
    script: "dash.js",
  })

  // 2) 注册该页面用到的接口（registerApi 自动套用登录鉴权）
  //    第一个参数可用 "get" / "post" / "delete" / "patch"；
  //    route 可为相对路径（/foo）或完整路径（/web/api/foo）
  registerApi("get", "/my-page/data", (req, res) => {
    res.json({ ok: true, count: 42 })
  })

  // 也可以批量注册多个页面
  registerPages([
    { id: "p1", title: "P1", html: "<p>1</p>" },
    { id: "p2", title: "P2", html: "<p>2</p>" },
  ])
}
```

`ctx` 在页面 / 接口注册时提供的字段：

| 字段 | 说明 |
| --- | --- |
| `basePath` | Web 根路径（不含前导 `/`），如 `qqbot-web` |
| `apiBase` | API 前缀，如 `/qqbot-web/api` |
| `pluginName` | 插件目录名 |
| `pluginDir` | 插件绝对目录 |
| `logger` | 日志对象 |
| `requireAuth` | 鉴权中间件，可挂到自定义路由上（已登录放行，未登录返回 401） |
| `registerApi` | `(method, route, ...handlers)` 自动鉴权的接口注册器 |
| `registerPage` | `(def)` 注册单个页面（等价于 `Bot.webAdapter.registerPage(pluginName, def)`） |
| `registerPages` | `(arr)` 批量注册页面 |

> 若不想用 `ctx` 上的方法，也可直接调用 `Bot.webAdapter.registerPage(pluginName, def)` /
> `Bot.webAdapter.registerApi(method, route, ...handlers)`，效果相同。

> **路径安全（重要）**：凡是接口内部**读取或改动本地文件**（如 `fs.readFile` / `writeFile` /
> `unlink` 拼接 `req.params`、`req.query`、`req.body` 中的文件名/路径），都必须做好**目录穿越防护**，
> 否则攻击者可借 `/api/...` 接口越权读写插件目录甚至系统文件。建议统一遵守：
> 1. **过滤危险字符**：用白名单只保留 `[\\w一-龥.\\-]` 之外的字符替换为 `_`，把 `/` `\\` 等路径分隔符去掉；
> 2. **显式拒绝 `..`**：若输入含 `..` 子串、为空或后缀不合法（如非 `.json`），直接返回 `400`；
> 3. **拼接后兜底校验**：始终用 `path.join(baseDir, name)` 并校验结果以 `baseDir + path.sep` 开头，
>    切勿直接把用户输入拼进路径或用 `path.resolve` 解析绝对路径。

---

## 四、完整示例（以 replaceButton 为例）

下面是本仓库 `plugins/replaceButton-plugin/webadapter/index.js` 的精简版，展示「页面 + 接口」一起注册的完整写法（新风格）：

```js
import { Bot } from "yunzai"

export function init(ctx) {
  const { pluginName, registerPage, registerApi } = ctx

  // 1) 注册管理页面（iframe 嵌入 webadapter/manage.html）
  registerPage({
    id: "replace-button",
    title: "按钮替换",
    icon: "🔘",
    src: "manage.html",
    script: "manage.js",
  })

  // 2) 注册该页面用到的接口，全部走 registerApi（自动套用登录鉴权）
  registerApi("get",    "/replace-button/rules",        (_req, res) => { /* 读取规则文件 */ })
  registerApi("post",   "/replace-button/rules",        (req, res) => { /* 新增 / 覆盖规则 */ })
  registerApi("delete", "/replace-button/rules/:file",  (req, res) => { /* 删除规则 */ })
  registerApi("patch",  "/replace-button/rules/:file",  (req, res) => { /* 开关 / 改描述 */ })
}
```

> **接口鉴权（重要）**：所有 `/api/*` 请求（含各插件操作模块注册的接口）都会被 WebAdapter
> 强制加上**公网限制 + 登录鉴权**。因此**请务必使用 `ctx.registerApi` 注册接口**（或自行
> `Bot.express` 注册后 `app.use(requireAuth)`），不要裸注册 `Bot.express.get(...)`——否则该接口会在
> 开机扫描阶段被注册到全局鉴权中间件之前而绕过后端校验。

> WebAdapter 会在开机以及 `login` / `plugins/loaded` 事件时自动 `import` 并调用
> 各插件的 `webadapter/index.js`，**插件主入口 `index.js` 无需任何改动**。

完整可运行实现见：`plugins/replaceButton-plugin/webadapter/`（既注册了管理页面，又注册了接口，
且接口均通过 `registerApi` 受鉴权保护，写操作成功后还会自动重载内存规则）。
其 `rules` 相关接口即为**读取/改动本地文件 + 路径穿越防护**的参考实现：文件名经白名单过滤、显式拒绝
`..`、拼接后用 `startsWith(buttonsDir + sep)` 兜底校验，可照此写法保护你自己的文件接口。

---

## 五、静态资源与鉴权

- 页面引用的 `src` / `style` / `script` 文件，统一通过
  `GET /<basePath>/api/web-page/<插件名>/<文件>` 提供。
- 这些文件必须位于**该插件的 `webadapter/` 目录内**（有防目录穿越校验），
  允许的后缀：`html, js, css, json, svg, png, jpg, jpeg, gif, webp, ico, woff, woff2, ttf, map`。
- 自定义页面接口与静态资源都受 WebAdapter 的登录鉴权保护：所有 `/api/*`（含插件接口）
  都必须通过公网限制 + 登录校验；未登录访问管理接口会收到 `401`，未登录访问页面会跳转登录页。

---

## 六、生效与调试

- 自定义页面在 **WebAdapter 启动扫描** 或收到 `login` / `plugins/loaded` 事件时加载。
- 新增 / 修改页面后，一般 **重启 Yunzai** 最稳妥；若只是改了已加载页面引用的 HTML/JS/CSS 静态文件，刷新浏览器即可。
- 当前已加载的页面列表可访问 `GET /<basePath>/api/web-pages` 查看。
- 加载失败会在日志中打印（`加载自定义页面失败 ...`），按提示修正 `id` / 路径即可。
