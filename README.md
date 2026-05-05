# fed-workflow

基于 [Anthropic Agent SDK](https://github.com/anthropics/claude-agent-sdk) 的群组智能助手。以飞书群为单位，为每个群提供独立的 Agent，承担开发、写作、研究等多种角色任务。

## 依赖

- [Bun](https://bun.com) runtime
- [lark-cli](https://github.com/larksuite/cli) — 飞书命令行工具

## 安装

```bash
bun install
```

## 飞书授权

本工具所有 API 调用均使用 bot 身份（`--as bot`），无需用户登录。只需确保 bot 应用已创建并授权：

```bash
# 查看当前授权状态
lark-cli auth status

# 如果未授权，使用 bot 身份登录
lark-cli auth login

# 验证 bot 可用
lark-cli api GET /open-apis/bot/v3/info/ --as bot
```

### Bot 应用所需权限

在飞书开放平台为 bot 应用开启以下 scope：

| Scope | 用途 |
|-------|------|
| `im:chat:read` | 读取群信息 |
| `im:message:readonly` | 读取消息 |
| `im:message:send_as_bot` | 发送消息 |
| `im:resource` | 下载图片/文件 |

## 快速开始

### 1. 初始化

```bash
bun run index.ts --init
```

生成 `~/.fed-workflow/config.yaml`，编辑填入实际的 `zhipu_token`：

```yaml
env:
  LOG_LEVEL: info
  zhipu_token: your_token_here
webhook:
  host: 0.0.0.0
  port: 7700
projects:
  - chatId: oc_xxx
    cwd: /path/to/project
    favorite:
      - 张三 称呼为三哥
```

### 2. 群内自动配置

未配置的群，发送以下消息即可自动注册：

```
/init 张三 称呼为三哥
```

自动创建项目目录 `~/.fed-workflow/projects/{chatId}`，拉取群名称/描述，写入配置文件。

### 3. 启动

```bash
bun run index.ts
```

## 群内指令

在飞书群中直接发送以下指令，即可控制 Agent 行为：

| 指令 | 说明 |
|------|------|
| `/init 决策人信息` | 自动配置新群，或重新启用已禁用的群。如 `/init 张三 称呼为三哥` |
| `/stop` | 强制终止当前正在运行的任务 |
| `/reset` | 重置会话，下次对话开启新 session |

## 配置文件

配置文件路径：`~/.fed-workflow/config.yaml`，YAML 格式，支持多群，每个群独立工作目录、会话、决策人。

### 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `env` | 否 | 环境变量，优先于系统环境变量 |
| `webhook.host` | 否 | Webhook 服务监听地址，默认 `0.0.0.0` |
| `webhook.port` | 否 | Webhook 服务端口，默认 `7700` |
| `projects` | 是 | 项目列表 |
| `projects[].chatId` | 是 | 飞书群 chat_id |
| `projects[].cwd` | 是 | 项目工作目录，agent 在此目录下工作 |
| `projects[].favorite` | 否 | 决策人列表，群内有异议时以他们的意见为准 |
| `projects[].groupName` | 否 | 群名称，留空则启动时自动获取并回填 |
| `projects[].description` | 否 | 群描述，留空则启动时自动获取并回填 |
| `projects[].conversationId` | 否 | 会话 ID，自动创建并回填（用于会话续接） |
| `projects[].disabled` | 否 | 群不可访问时自动标记为 true，恢复时删掉此行即可 |

## 其他命令

```bash
--version    查看版本
--help       查看帮助
--list       查看飞书群组列表（用于获取 chatId）
--init       创建配置文件模板
```

## 架构

### Channel 抽象

消息源通过 Channel 接口抽象，飞书是默认实现。chatId 统一带前缀（如 `lark:oc_xxx`）避免跨 channel 冲突。新增消息源只需实现 `ChannelImpl` 接口。

```
src/
  cli.ts              入口：CLI 解析 + 消息调度循环
  agent.ts            Agent SDK 调用：MCP 工具
  config.ts           YAML 配置读写，自动回填
  const.ts            常量 + 类型 + 系统提示词
  cronManager.ts      定时任务管理
  webhookManager.ts   Webhook 管理
  env.ts              环境变量统一入口
  log.ts              分级日志
  message/
    types.ts          Message, SendContent 等标准类型
    channel.ts        Channel 路由层 + feed 防抖 + 事件注入
    userCache.ts      用户缓存
  lark/
    index.ts          LarkImpl — 飞书 Channel 实现
    schemas.ts        飞书消息 Zod schema
    api.ts            飞书 API 封装
    listen.ts         消息监听
    send.ts           消息发送 + 下载 + TTS
    format.ts         消息格式化
```

### 多群并行

- 不同群之间并行执行
- 同一群内串行：前一个任务完成后，合并所有待处理消息（最多 50 条）作为下一轮输入

### 会话续接

- 每个群维护独立的会话，`conversationId` 自动回填到配置文件
- 重启后自动续接上次会话上下文
- 修改 cwd 下的 `.claude/settings.json` 或 `.claude/settings.local.json` 后，需发送 `/reset` 开启新 session

### MCP 工具

Agent 可用的 Channel MCP 工具：

| 工具 | 说明 |
|------|------|
| `send` | 发送消息（type=text/image/file/audio） |
| `fetch_chat_detail` | 获取当前群详情 |
| `fetch_message_resource` | 下载消息中的图片或文件 |
| `cron` | 创建或更新定时任务（传 id 更新，不传创建） |
| `cron_delete` | 删除定时任务 |
| `cron_list` | 列出当前群的定时任务 |
| `webhook` | 创建或更新 webhook（传 id 更新，不传创建） |
| `webhook_delete` | 删除 webhook |
| `webhook_list` | 列出当前群的 webhook |

### 定时任务

- Agent 可通过 `cron` 工具创建定时任务，传入 `one_shot=true` 为一次性任务（触发后自动删除）
- 定时任务按群隔离，持久化到 `~/.fed-workflow/cron.yaml`
- 支持 id 参数：传入已有 id 为更新，不传为创建

### Webhook

- Agent 可通过 `webhook` 工具创建 HTTP 端点，外部系统（CI/CD、监控、第三方服务）通过 HTTP 请求触发 Agent
- 默认 POST 方法，支持 GET 等其他方法
- prompt 支持 `{{body}}`（请求体）和 `{{url}}`（完整请求 URL）占位符
- `expires_in` 支持语义化值：`30m`、`1h`、`6h`、`12h`、`1d`、`7d`、`30d`，不传为一次性（触发后自动删除）
- URL 格式：`http://{host}:{port}/agent/hook/{id}`
- 按群隔离，持久化到 `~/.fed-workflow/webhooks.yaml`
- 启动时自动清理过期 webhook
- 支持 id 参数：传入已有 id 为更新，不传为创建

### 身份一致性

Agent 具有跨群一致的身份，通过三层机制保障：

**启动顺序**（不可跳过）：灵魂 → 人物画像 → 群规则

**优先级铁律**：灵魂 > 人物关系 > 群规则 > 任务指令

- 灵魂不可违反：原则、教训、认知
- 人物关系不可忽略：对同一个人的态度，哪个群都一样
- 群规则只能规定做什么、怎么做，不能规定态度和立场

**自检**：每次回复前检查性格是否漂移、对人的态度是否一致

### 灵魂

- 灵魂文件 `~/.fed-workflow/soul.md`，全局共享，跨群唯一
- 记录原则、教训、认知变化——像一个真实的人在成长
- Agent 自己决定写什么、怎么写

### 用户画像

- 画像是全局的：同一个人在不同群共享同一个画像
- 索引文件 `~/.fed-workflow/profiles/index.md`，所有画像均可通过此文件找到
- 画像是你对这个人的感受和印象，只记人的印象，不记群规则和任务指令
- 创建或更新画像后必须同步更新索引

### 语音消息

- Agent 可通过 `send` 工具（type=audio）发送语音消息（TTS 文本转语音）
- 支持停顿控制 `<#秒数#>`、语气词标签 `(laughs)` `(sighs)` 等
- 传 `audio_help=true` 查看完整参数说明

### 素笔风格

- 默认使用素笔（su-bi）风格说话和写文件，用户明确要求其他风格时除外
- 素笔：短句、克制、留白，用细节说话，不解释，让读者自己感受
- Skill 文件：`skills/su-bi/SKILL.md`，启动时自动部署到 `~/.claude/skills/su-bi/`

### .claude 目录

- Agent 沙箱禁止直接写入 `.claude` 目录
- 需要写 skills、settings 等到 `.claude` 时，先写到项目其他位置，再用 `dot-claude_install` MCP 工具移动过去

### 日志

- 日志文件：`~/.fed-workflow/log/log-{日期}.txt`
- 每天一个文件，重启覆盖

## 环境变量

环境变量优先从配置文件 `env` 字段读取，没有再从系统获取。

| 变量 | 必填 | 说明 |
|------|------|------|
| `zhipu_token` | 是 | 智谱 API Token |
| `MINIMAX_KEY` | 否 | MiniMax TTS Token，用于语音消息 |
| `LOG_LEVEL` | 否 | 日志级别，默认 `info`，可选 `debug` |
