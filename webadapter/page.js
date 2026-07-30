// 约定式自定义页面：展示「自定义页面写法」说明
// 页面内容写在同目录的 page.html 中，以 iframe 形式嵌入。
// WebAdapter 会在开机 / login / plugins/loaded 时自动扫描并注册本描述符。
export default {
  id: "web-page-guide",
  title: "自定义页面写法",
  icon: "📝",
  priority: 100,
  src: "page.html"
}
