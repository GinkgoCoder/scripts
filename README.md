# URL 笔记管理系统

这是一个基于文件的URL笔记管理系统，使用Python服务器在本地存储笔记和绘图。

## 项目组成

### 1. Python 服务器 (notes_server.py)
- 运行在端口 3001
- 提供 RESTful API 来存储和读取笔记与绘图
- 笔记存储为 markdown 文件在 `~/.urlnotes/` 目录
- Excalidraw 绘图存储为 JSON 文件在 `~/.excalidraw/` 目录

### 2. 用户脚本 (tampermonkey/ 目录)
三个 Tampermonkey 浏览器脚本：
- `note-url.js`: 为每个网页URL创建 markdown 笔记，支持AI优化
- `page-summary.js`: 生成网页内容摘要
- `excalidraw-whiteboard.js`: 为每个网页URL创建 Excalidraw 绘图

## 功能特点

- **本地存储**: 所有数据存储在本地文件系统，无需云服务
- **URL绑定**: 为每个网页URL单独存储笔记和绘图
- **AI优化**: 支持使用外部API优化笔记内容
- **跨浏览器**: 只要运行服务器，可在不同浏览器间同步
- **持久化**: 笔记不会因浏览器缓存清理而丢失

## 启动使用

1. 安装 Python 依赖：`pip install fastapi uvicorn`
2. 启动服务器：`python3 python/notes_server.py`
3. 在 Tampermonkey 中安装相应用户脚本
4. 访问任意网页，点击右边悬浮按钮使用相应功能

## API 接口

- `GET/POST/DELETE /api/notes/{url_hash}` - 笔记操作
- `GET/POST/DELETE /api/excalidraw/{url_hash}` - 绘图操作

## 存储结构

- 笔记文件：`~/.urlnotes/{url_hash}.md`
- 绘图文件：`~/.excalidraw/{url_hash}.json`