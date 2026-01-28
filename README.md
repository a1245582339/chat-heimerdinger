# Chat Heimerdinger

[![npm version](https://badge.fury.io/js/chat-heimerdinger.svg)](https://www.npmjs.com/package/chat-heimerdinger)

IM 与 Claude Code 的桥接工具，让你在 Slack 或飞书中直接与 Claude Code 进行对话式编程。

## 功能特性

- **多平台支持**：支持 Slack 和飞书（Feishu/Lark）
- **项目管理**：支持多项目切换，自动记忆每个频道的项目上下文
- **会话持久化**：自动恢复上次对话，保持编程上下文连续性
- **语音消息**：支持语音消息，自动转写为文字发送给 Claude Code
- **实时反馈**：流式输出 Claude 的响应，实时显示代码修改
- **权限控制**：支持权限审批流程，安全执行敏感操作

## 前置准备

### 1. Node.js 环境

需要 Node.js 18.0.0 或更高版本：

```bash
node -v  # 确认版本 >= 18.0.0
```

### 2. 安装 Claude Code

确保本机已安装并配置好 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)：

```bash
# 安装 Claude Code
npm install -g @anthropic-ai/claude-code

# 验证安装
claude --version
```

### 3. 创建 IM Bot

根据你要使用的平台，选择对应的配置方式：

<details>
<summary><b>Slack 配置</b></summary>

1. 访问 [Slack API](https://api.slack.com/apps) 创建新应用
2. 选择 **From an app manifest**
3. 导入本仓库的 [slack-bot-demo.json](https://github.com/a1245582339/chat-heimerdinger/blob/main/slack-bot-demo.json) 文件
4. 安装应用到你的 Workspace
5. **重要配置**：进入 **App Home** -> **Show Tabs**：
   - 开启 **Messages Tab**
   - 勾选 **"Allow users to send Slash commands and messages from the messages tab"**（必须勾选，否则无法私聊 Bot）

**获取 Token：**

| Token | 位置 |
|-------|------|
| Bot Token (xoxb-) | OAuth & Permissions > Bot User OAuth Token |
| App Token (xapp-) | Basic Information > App-Level Tokens (需创建，scope 选 `connections:write`) |
| Signing Secret | Basic Information > App Credentials |

</details>

<details>
<summary><b>飞书配置</b></summary>

1. 访问[飞书开放平台](https://open.feishu.cn/app)创建新应用
2. 在 **凭证与基础信息** 中获取 App ID 和 App Secret
3. 在 **事件与回调** 中：
   - 订阅方式选择 **使用长连接接收事件**（推荐，无需公网 IP）
   - 或选择 Webhook 方式（需要公网 URL）
   - 添加事件 `im.message.receive_v1`
4. 在 **权限管理** 中添加以下权限：
   - `im:message` - 获取与发送单聊、群组消息
   - `im:message:send_as_bot` - 以应用的身份发送消息
   - `im:resource` - 获取与上传图片或文件资源
   - `im:chat:readonly` - 获取群组信息
5. 启用机器人能力并发布应用

**获取凭证：**

| 凭证 | 位置 |
|------|------|
| App ID | 凭证与基础信息 > App ID |
| App Secret | 凭证与基础信息 > App Secret |
| Encrypt Key (Webhook 模式) | 事件与回调 > Encrypt Key |
| Verification Token (Webhook 模式) | 事件与回调 > Verification Token |

</details>

## 快速开始

```bash
# 初始化配置（交互式选择 Slack 或飞书）
npx chat-heimerdinger init

# 启动服务
npx chat-heimerdinger start
```

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

### 交互方式

**Slack：**
- 直接私信机器人
- 在频道中 @机器人
- 发送语音消息

**飞书：**
- 直接私信机器人
- 在群组中 @机器人

### 命令

| 命令 | 说明 | 平台 |
|------|------|------|
| `/project` | 切换项目 | Slack |
| `/stop` | 停止当前执行 | Slack |
| `/clear` | 清除会话，开始新对话 | Slack |

> 飞书暂不支持斜杠命令，可以直接发送 "切换项目"、"停止" 等文字指令。

## 配置文件

配置文件位于 `~/.heimerdinger/config.json`：

**Slack 配置示例：**
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

**飞书配置示例：**
```json
{
  "activeAdapter": "feishu",
  "adapters": {
    "feishu": {
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "connectionMode": "websocket",
      "domain": "feishu"
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

### 飞书连接模式

| 模式 | 说明 |
|------|------|
| `websocket` | 长连接模式（推荐），无需公网 IP |
| `webhook` | Webhook 模式，需要公网 URL |

### 飞书域名

| 域名 | 说明 |
|------|------|
| `feishu` | feishu.cn（中国区） |
| `lark` | larksuite.com（国际区） |

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

1. **项目必须已初始化**：需要先在项目目录中使用过 Claude Code，才能在 IM 中选择该项目
2. **权限配置**：确保 Bot 已添加所有必要的权限
3. **语音功能可选**：如不需要语音转文字，可跳过 whisper.cpp 安装
4. **网络要求**：
   - Slack：需要能访问 Slack API（Socket Mode 使用 WebSocket）
   - 飞书：WebSocket 模式需要能访问飞书开放平台；Webhook 模式需要公网可访问的 URL

## 开发

```bash
# 构建
pnpm build

# link
pnpm link

# 格式化
pnpm format
```

## License

MIT
