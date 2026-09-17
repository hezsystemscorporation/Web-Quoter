# Web Quoter

A Chrome/Edge extension that converts a selected text+image region of any web page into a Markdown file (with bold/italic detection and locally downloaded images), packaged as a ZIP.

一个 Chrome/Edge 浏览器插件：将网页中选中的文字与图片区域转换为 Markdown 文件（自动识别加粗/斜体、下载关联图片到本地），并打包为 ZIP 下载。

## Features / 功能说明

- 右键菜单 "保存选中内容为 MD 压缩包"，仅在选中内容时出现 / Right-click context menu, shown only when text is selected
- 选区转 Markdown：标题、段落、列表、引用、代码块、表格、链接、图片 / Selection → Markdown (headings, lists, quotes, code, tables, links, images)
- 加粗/斜体识别：基于计算样式，兼容基础 CSS、内联样式与 TailwindCSS（`font-bold`、`italic` 等）/ Bold & italic detection via computed styles, works with plain CSS and Tailwind classes
- 图片本地化：抓取选区内 `<img>` 与 CSS 背景图，保存到 ZIP 的 `images/` 目录并重写引用 / Downloads inline and CSS-background images into `images/` and rewrites links
- 附件下载：识别选区内指向文件的链接（pdf/docx/zip 等），自动跟随重定向、解析 Moodle `view.php` 类"延迟真实链接"页面，下载至 `attachments/` 并改写链接 / Resolves lazy file links (e.g. Moodle resource pages) into `attachments/`
- 重复文件过滤：按内容 SHA-256 判重（如图标链接与文字链接指向同一文件），可在选项页选择"跳过共用"或"保存并重命名 (2)" / Content-hash dedup with skip / rename policy
- 无图片/无附件时正常输出仅含 MD 的 ZIP，不产生空目录 / Works fine with text-only selections
- 界面语言：English / 简体中文 / 繁體中文 / 한국어 / 日本語 / Français 六选一，单语言不混排，设置页顶部一键切换（右键菜单与系统通知同步跟随）/ 6 UI languages, one at a time, switchable in options
- 纯文本选区（无图片、无附件文件）时直接导出 `.md` 文件而非 ZIP / Text-only selections export a plain .md file instead of a ZIP
- 输出 ZIP 命名：`[网址]_的摘要_于[YYYY-MM-DD HH：MM：SS].zip`（冒号使用全角字符以保证文件名合法），支持在选项页用模板自定义（`{site}` `{url}` `{title}` `{date}` `{time}` `{datetime}`）
  Configurable filename template via options page
- 纯原生实现，无第三方依赖（内置 ZIP STORE 编码器）/ Zero dependencies (built-in ZIP writer)

## Environment / 运行环境

- Chrome 110+ 或 Edge 110+（Manifest V3）/ Chrome or Edge, Manifest V3
- 无需 Node.js / 构建步骤；插件为纯 JS / No build step required
- 权限：`contextMenus`、`downloads`、`storage`、`notifications`、`<all_urls>`（用于跨域抓取图片）

## Install / 部署说明

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 开启右上角 "开发者模式 / Developer mode"
3. 点击 "加载已解压的扩展程序 / Load unpacked"，选择本仓库的 `quote_site/` 文件夹
4. （保存本地 `file://` 页面时需要）扩展详情 → 开启 "允许访问文件网址 / Allow access to file URLs"
5. **安装或更新插件后，刷新已打开的网页**（否则内容脚本未注入，右键会无反应）
6. 完成。任意网页中选中一段图文，右键选择 "保存选中内容为 MD 压缩包"

ZIP is saved to your browser Downloads folder. / ZIP 会保存到浏览器"下载"目录。

## Architecture / 架构说明

```
Browser page                          Service worker (background.js)
+---------------------------+   msg   +-----------------------------+
| content.js                | <-----> | context menu registration   |
|  selection -> Markdown    |  ZIP    | fetch images (bypass CORS)  |
|  computed-style detection |  bytes  | zipSync (STORE + CRC32)     |
|  collect image URLs       |         | chrome.downloads.download   |
+---------------------------+         +-----------------------------+
```

- `content.js`：在页面隔离环境中遍历选区 DOM，生成含绝对图片 URL 的 Markdown，收集图片与链接列表 / builds Markdown from the selection, collects image + link URLs
- `background.js`：抓取图片与附件（含 cookie，绕过 CORS；自动解析重定向/延迟真实链接）、SHA-256 内容去重、按模板生成文件名、生成 ZIP、触发下载 / fetches images & attachments, dedups by hash, builds ZIP, downloads
- `options.html` + `options.js`：全局设置页——语言切换、文件命名模板（占位符+实时预览）、附件下载开关、重复文件策略（存 `chrome.storage.local`）/ global options page: language switch, filename template, attachment toggle, dedup policy
- `i18n.js`：六语 UI 词典 + `detectLang`/`tr`，被后台 `importScripts` 与设置页共享，单语言渲染 / shared UI dictionary for 6 languages
- `manifest.json`：MV3 配置 / MV3 config; `icons/`：16/48/128 PNG 图标
