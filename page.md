# 自定义页面写法（WebAdapter 扩展控制台）

QQBot-Web-Adapter 支持在不改动插件主入口的情况下，给 Web 控制台新增自定义页面。
页面会出现在左侧导航栏，支持两种注册方式：

1. **约定式**：在插件目录下新建 `webadapter/page.{js,json}`（或 `pages.{js,json}`），导出描述符即可，WebAdapter 开机自动扫描。
2. **编程式**：在代码里调用 `Bot.webAdapter.registerPage(pluginName, descriptor)`。

> 约定式最常用；如果你的页面还需要自定义后端接口（API），请同时提供一个 `webadapter/index.js` 操作模块（见下文「操作模块」）。

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

## 二、约定式示例

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

## 三、编程式注册

适合需要动态生成页面、或在同一处既注册页面又注册 API 的场景：

```js
import { Bot } from "yunzai"

export function init(ctx) {
  Bot.webAdapter.registerPage(ctx.pluginName, {
    id: "my-page",
    title: "我的页面",
    icon: "⚙️",
    html: "<h2>你好</h2>"
  })

  // 也可以批量
  Bot.webAdapter.registerPages(ctx.pluginName, [
    { id: "p1", title: "P1", html: "<p>1</p>" },
    { id: "p2", title: "P2", html: "<p>2</p>" }
  ])
}
```

`pluginName` 一般用 `ctx.pluginName`（自动等于插件目录名）。
不传时默认归到 `external`。

---

## 四、操作模块（页面 + 自定义接口）

如果你只是展示静态内容，上面的约定式就够了。
但若页面需要后端数据接口，请在该插件下新建 `webadapter/index.js`，导出 `init(ctx)`：

```js
import { Bot } from "yunzai"

export function init(ctx) {
  const { apiBase, pluginName } = ctx
  // apiBase 形如 /qqbot-web/api

  // 1) 注册一个页面
  Bot.webAdapter.registerPage(pluginName, {
    id: "stats",
    title: "统计",
    icon: "📈",
    src: "stats.html",
    script: "stats.js"
  })

  // 2) 注册该页面用到的接口
  Bot.express.get(`${apiBase}/stats/data`, (req, res) => {
    res.json({ ok: true, count: 42 })
  })
}
```

`ctx` 提供的字段：

| 字段 | 说明 |
| --- | --- |
| `basePath` | Web 根路径（不含前导 `/`），如 `qqbot-web` |
| `apiBase` | API 前缀，如 `/qqbot-web/api` |
| `pluginName` | 插件目录名 |
| `pluginDir` | 插件绝对目录 |
| `logger` | 日志对象 |

> WebAdapter 会在开机以及 `login` / `plugins/loaded` 事件时自动 `import` 并调用
> 各插件的 `webadapter/index.js`，**插件主入口 `index.js` 无需任何改动**。

参考实现：本仓库 `plugins/replaceButton-plugin/webadapter/` 就是一个完整的操作模块
（既注册了管理页面接口，又注册了页面本身）。

---

## 五、静态资源与鉴权

- 页面引用的 `src` / `style` / `script` 文件，统一通过
  `GET /<basePath>/api/web-page/<插件名>/<文件>` 提供。
- 这些文件必须位于**该插件的 `webadapter/` 目录内**（有防目录穿越校验），
  允许的后缀：`html, js, css, json, svg, png, jpg, jpeg, gif, webp, ico, woff, woff2, ttf, map`。
- 自定义页面接口与静态资源都受 WebAdapter 的全局登录鉴权保护。

---

## 六、生效与调试

- 自定义页面在 **WebAdapter 启动扫描** 或收到 `login` / `plugins/loaded` 事件时加载。
- 新增 / 修改页面后，一般 **重启 Yunzai** 最稳妥；若只是改了已加载页面引用的 HTML/JS/CSS 静态文件，刷新浏览器即可。
- 当前已加载的页面列表可访问 `GET /<basePath>/api/web-pages` 查看。
- 加载失败会在日志中打印（`加载自定义页面失败 ...`），按提示修正 `id` / 路径即可。
