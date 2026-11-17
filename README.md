# WebPilot AI 网页数据助手

Chrome 扩展（Manifest V3）：从**你选择的公开网页**提取结构化表格数据，按设定间隔监控变化，并支持 Webhook 推送与周报导出。

> 边界说明：仅用于公开页面的数据提取与变化监控；不绕过登录、验证码或访问限制。

## 功能概览

- 在页面上框选或自动识别表格/列表类数据
- 字段对齐与差异对比（新增 / 修改 / 删除）
- 定时检查与通知（Webhook）
- 选项页配置 API Key、检查间隔等

## 本地加载（开发者模式）

1. 打开 Chrome → `chrome://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本仓库根目录（含 `manifest.json` 的文件夹）
4. 在扩展「选项」中配置 API Key 与 Webhook（如需要）

## 项目结构

| 路径 | 说明 |
|------|------|
| `manifest.json` | 扩展清单 |
| `background.js` | Service Worker：调度、对比、推送 |
| `content.js` / `content.css` | 页面注入与 UI |
| `lib/extract-core.js` | 提取与 diff 核心逻辑 |
| `popup/` | 浏览器工具栏弹窗 |
| `options/` | 设置页 |
| `report.html` | 报告视图 |

## 与 WebPilot SaaS 的关系

本仓库为**浏览器端**扩展。配套的 Web SaaS（账户、云端监控、配对等）见同级目录 `web-saas/` 或独立仓库（若已拆分）。

## 许可证

请在发布前补充 LICENSE 文件；当前为私有/未声明状态。