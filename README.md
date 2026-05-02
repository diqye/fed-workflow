# fed-workflow

基于 [Anthropic Agent SDK](https://github.com/anthropics/claude-agent-sdk) 的群组智能助手。以飞书群为单位，为每个群提供独立的 Agent，承担开发、写作、研究等多种角色任务，提供出色的生产力。

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
| `/reset` | 重置会话，下次对话开启新 session（修改 hooks 等配置后使用） |

## 配置文件

配置文件路径：`~/.fed-workflow/config.yaml`，YAML 格式，支持多群，每个群独立工作目录、会话、决策人。

### 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `env` | 否 | 环境变量，优先于系统环境变量 |
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

## 工作流程

1. 程序监听飞书群消息
2. 判断是否需要处理的任务（重点关注 @机器人 的消息）
3. 确认任务后：`send_message` 通知群内领取 → 编辑 `fed-task.md` 追加任务
4. 编码任务调用 coder agent 完成编码、commit、push
5. 完成后更新任务状态，`send_message` 发送完成报告和 MR 链接

### 多群并行

- 不同群之间并行执行
- 同一群内串行：前一个任务完成后，合并所有待处理消息（最多 50 条）作为下一轮输入

### 会话续接

- 每个群维护独立的会话，`conversationId` 自动回填到配置文件
- 重启后自动续接上次会话上下文
- 修改 cwd 下的 `.claude/settings.json` 或 `.claude/settings.local.json`（如 hooks）后，需发送 `/reset` 开启新 session 才能生效

### 定时任务

- Agent 可通过 MCP 工具 `cron_create` / `cron_delete` / `cron_list` 管理定时任务
- 定时任务按群隔离，持久化到 `~/.fed-workflow/cron.yaml`
- 一次性任务：在 prompt 中包含"触发后删除此任务"，Agent 会自行调用 `cron_delete` 清理

### 语音消息

- Agent 可通过 `send_audio` MCP 工具发送语音消息（TTS 文本转语音）
- 支持停顿控制 `<#秒数#>`、语气词标签 `(laughs)` `(sighs)` 等
- 传 `help=true` 查看完整参数说明

### 用户画像

- 画像是**全局的**：同一个人在不同群共享同一个画像文件
- 画像记录对人的感受和印象，像真人一样有感情，不同的人态度不同
- 画像文件存放在 `~/.fed-workflow/profiles/` 下

### 灵魂

- Agent 维护自己的灵魂文件 `~/.fed-workflow/soul.md`，全局共享
- 记录原则、教训、认知变化——像一个真实的人在成长
- Agent 自己决定写什么、怎么写

### 素笔风格

- 默认使用素笔（su-bi）风格说话和写文件，用户明确要求其他风格时除外
- 素笔：短句、克制、留白，用细节说话，不解释，让读者自己感受
- Skill 文件：`skills/su-bi/SKILL.md`，启动时自动部署到 `~/.claude/skills/su-bi/`

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
