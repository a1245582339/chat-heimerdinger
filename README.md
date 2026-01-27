# Chat Heimerdinger

[![npm version](https://badge.fury.io/js/chat-heimerdinger.svg)](https://www.npmjs.com/package/chat-heimerdinger)

Slack 与 Claude Code 的桥接工具，让你在 Slack 中直接与 Claude Code 进行对话式编程。

## 功能特性

- **Slack 集成**：通过 Slack Bot 对话与 Claude Code 交互
- **项目管理**：支持多项目切换，自动记忆每个频道的项目上下文
- **会话持久化**：自动恢复上次对话，保持编程上下文连续性
- **语音消息**：支持 Slack 语音消息，自动转写为文字发送给 Claude Code
- **实时反馈**：流式输出 Claude 的响应，实时显示代码修改
- **权限控制**：支持权限审批流程，安全执行敏感操作

## 快速开始

```bash
# 初始化配置
npx chat-heimerdinger init

# 启动服务
npx chat-heimerdinger start
```

## 配置

### 1. 创建 Slack App

1. 访问 [Slack API](https://api.slack.com/apps) 创建新应用
2. 选择 **From an app manifest**，粘贴 [slack-bot-demo.yaml](./slack-bot-demo.yaml) 的内容
3. 安装应用到你的 Workspace

### 2. 获取 Token

| Token | 位置 |
|-------|------|
| Bot Token (xoxb-) | OAuth & Permissions > Bot User OAuth Token |
| App Token (xapp-) | Basic Information > App-Level Tokens (需创建，scope 选 `connections:write`) |
| Signing Secret | Basic Information > App Credentials |

### 3. 初始化配置

```bash
npx chat-heimerdinger init
```

按提示输入上述 Token 即可。

## 使用

### 启动服务

```bash
# 后台运行（推荐）
npx chat-heimerdinger start

# 前台运行（调试）
npx chat-heimerdinger start -f

# 查看状态
npx chat-heimerdinger status

# 查看日志
npx chat-heimerdinger logs

# 停止服务
npx chat-heimerdinger stop
```

### Slack 命令

| 命令 | 说明 |
|------|------|
| `/project` | 切换项目 |
| `/stop` | 停止当前执行 |
| `/clear` | 清除会话，开始新对话 |

### 交互方式

- **DM**：直接私信机器人
- **@mention**：在频道中 @机器人
- **语音**：发送语音消息（需安装 whisper-cli）

## 语音转文字（可选）

需要安装 [whisper.cpp](https://github.com/ggerganov/whisper.cpp)：

```bash
# 编译 whisper.cpp
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp && make

# 安装到系统
sudo cp build/bin/whisper-cli /usr/local/bin/

# 下载模型
mkdir -p ~/.local/share/whisper
bash models/download-ggml-model.sh small ~/.local/share/whisper
```

还需要 `ffmpeg` 进行音频格式转换：

```bash
sudo apt install ffmpeg  # Ubuntu/Debian
brew install ffmpeg      # macOS
```

## 配置文件

配置文件位于 `~/.heimerdinger/config.json`：

```json
{
  "activeAdapter": "slack",
  "adapters": {
    "slack": {
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "signingSecret": "...",
      "socketMode": true
    }
  },
  "server": {
    "port": 3150
  },
  "claude": {
    "permissionMode": "acceptEdits"
  }
}
```

### 权限模式

| 模式 | 说明 |
|------|------|
| `default` | 默认，需要确认敏感操作 |
| `acceptEdits` | 自动接受文件编辑 |
| `bypassPermissions` | 跳过所有权限检查（危险） |

## 全局安装（可选）

如果你经常使用，可以全局安装以省去 `npx` 前缀：

```bash
npm install -g chat-heimerdinger

# 之后可以直接使用
hmdg start
hmdg status
hmdg stop
```

## 从源码安装

```bash
# 克隆项目
git clone https://github.com/a1245582339/chat-heimerdinger.git
cd chat-heimerdinger

# 安装依赖
pnpm install

# 构建
pnpm build

# 全局链接
pnpm link --global
```

## 注意事项

1. **Claude Code 必须已安装**：确保本机已安装并配置好 [Claude Code](https://claude.ai/code)
2. **项目必须已初始化**：需要先在项目目录中使用过 Claude Code，才能在 Slack 中选择该项目
3. **Slack App 权限**：确保 Slack App 已添加所有必要的 OAuth Scopes
4. **语音功能可选**：如不需要语音转文字，可跳过 whisper.cpp 安装
5. **网络要求**：服务需要能访问 Slack API（Socket Mode 使用 WebSocket）

## 开发

```bash
# 开发模式（使用 tsx）
pnpm dev

# 构建
pnpm build

# 格式化
pnpm format
```

## License

MIT
