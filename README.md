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
4. 调用 coder agent 完成编码、commit、push
5. 完成后更新任务状态，`send_message` 发送完成报告和 MR 链接

### 多群并行

- 不同群之间并行执行
- 同一群内串行：前一个任务完成后，合并所有待处理消息（最多 50 条）作为下一轮输入

### 会话续接

- 每个群维护独立的会话，`conversationId` 自动回填到配置文件
- 重启后自动续接上次会话上下文

### 用户画像

- 画像是**全局的**：同一个人在不同群共享同一个画像文件
- 画像记录对人的感受和印象，像真人一样有感情，不同的人态度不同
- 画像文件存放在 `~/.fed-workflow/profiles/` 下

### 日志

- 日志文件：`~/.fed-workflow/log/log-{日期}.txt`
- 每天一个文件，重启覆盖

## 环境变量

环境变量优先从配置文件 `env` 字段读取，没有再从系统获取。

| 变量 | 必填 | 说明 |
|------|------|------|
| `zhipu_token` | 是 | 智谱 API Token |
| `LOG_LEVEL` | 否 | 日志级别，默认 `info`，可选 `debug` |
