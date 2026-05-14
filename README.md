# Inline Local Translator

一个可直接加载到 Edge 的本地翻译插件。

功能：

- 浏览网页时自动扫描常见英文正文块
- 在原文下方直接插入中文翻译
- 通过本地 `Ollama` 接口请求模型
- 支持动态页面内容继续翻译
- 长段落会自动分块翻译，减少漏翻
- 页面右上角显示实时翻译状态
- 支持 X/Twitter 的 tweet 正文结构
- 支持全局开关、启用站点白名单、当前站点开关、模型和接口配置

## 默认配置

- Ollama 地址：`http://localhost:11434/api/chat`
- 模型：`gemma4:e4b`

## 安装方式

1. 打开 Edge，进入 `edge://extensions`
2. 打开“开发人员模式”
3. 选择“加载解压缩的扩展”
4. 选择本目录：`~/repos/inline-local-translator`

## 使用方式

1. 确保本地 `Ollama` 已启动，并且目标模型可用
2. 打开任意英文网页
3. 插件会自动在检测到的英文段落后插入中文翻译
4. 点击插件图标可以：
   - 开关全局翻译
   - 把当前网站加入或移出启用列表
   - 手动触发当前页翻译
   - 清除当前页已插入翻译
5. 在设置页中可以修改启用站点列表、模型、接口地址、提示词和扫描规则

## 排查 403

如果插件里出现 `Ollama request failed with status 403`，通常不是模型问题，而是 `Ollama` 拒绝了浏览器扩展来源。

先确认：

- 终端里直接 `curl http://localhost:11434/api/chat ...` 能成功
- 但插件请求失败并返回 `403`

这种情况需要在运行 `Ollama` 的环境里允许扩展来源。

### Windows 启动方式

如果你的 `Ollama` 跑在 Windows，而插件也跑在 Windows Edge，那么需要在 Windows 里设置环境变量，然后重启 `Ollama`。

PowerShell 可以这样设置：

```powershell
setx OLLAMA_ORIGINS "chrome-extension://*,extension://*"
```

然后：

1. 彻底退出正在运行的 `Ollama`
2. 重新启动 `Ollama`
3. 刷新 Edge 里的目标网页后再试

如果你是手动在 PowerShell 里启动 `ollama serve`，也可以只在当前会话临时设置：

```powershell
$env:OLLAMA_ORIGINS = "chrome-extension://*,extension://*"
ollama serve
```

如果想先快速验证问题，也可以临时放开：

```powershell
setx OLLAMA_ORIGINS "*"
```

### WSL / Linux 启动方式

先停止旧的 `ollama serve`，然后用下面的方式启动：

```bash
export OLLAMA_ORIGINS="chrome-extension://*,extension://*"
ollama serve
```

如果你想先快速验证，也可以临时放开为：

```bash
export OLLAMA_ORIGINS="*"
ollama serve
```

### systemd 场景

如果你是通过 systemd 跑 `Ollama`，需要把环境变量写进 service override，然后重启服务。

核心就是保证 `OLLAMA_ORIGINS` 至少包含：

- `chrome-extension://*`
- `extension://*`

设置完成后，重启 `Ollama`，再回到 Edge 重新刷新页面测试。

## 说明

- 当前版本主要翻译段落级内容，不强行处理每一个行内短语，这样能明显降低误翻和页面布局破坏。
- `单次请求最大字符数` 控制每次发给 `Ollama` 的文本块大小。长段落会自动拆分后分别翻译，再拼接显示。
- X/Twitter 会额外扫描 `div[data-testid="tweetText"]` 和 `article div[lang][dir="auto"]`，以兼容运行时 React DOM。
- 只有在 `启用站点列表` 中列出的 hostname 会自动启用翻译。
- 如果某些网站正文结构特殊，可以在设置页调整 `扫描选择器`。
