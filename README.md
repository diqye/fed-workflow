# fed-workflow

基于 [Anthropic Agent SDK](https://github.com/anthropics/claude-agent-sdk) 的前端工作流，监听飞书群消息，自动领取前端开发任务，编码、commit、push，反馈 MR 链接。

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
| `contact:user.base:readonly` | 查询用户信息（MCP 工具） |

## 初始化配置

```bash
# 创建默认配置文件 fed-workflow.yaml
bun run index.ts --init

# 指定配置文件路径
bun run index.ts --init --config /path/to/my-config.yaml
```

## 配置文件

YAML 格式，支持多个群组（项目），每个群独立工作目录、会话、关注列表。

```yaml
log: /var/log/fed-workflow.log

projects:
  - chatId: oc_d2286cdb784ff2eb457964c8db0d9a58
    cwd: /data/user_home/devops/q
    favorite:
      - ou_e9f7c9b15d90d801cc3526de0a5cfcdd

  - chatId: oc_aaa111222333
    cwd: /data/user_home/devops/another-project
    favorite:
      - ou_xxx
      - ou_yyy
```

### 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `log` | 否 | 日志文件全路径，启动时清空 |
| `projects` | 是 | 项目列表 |
| `projects[].chatId` | 是 | 飞书群 chat_id |
| `projects[].cwd` | 是 | 项目工作目录，agent 在此目录下编码 |
| `projects[].favorite` | 否 | 特别关注的用户 open_id 列表，这些人的消息会优先响应 |
| `projects[].groupName` | 否 | 群名称，留空则程序启动时自动获取并回填 |
| `projects[].description` | 否 | 群描述，留空则程序启动时自动获取并回填 |
| `projects[].conversationId` | 否 | 会话 ID，留空则程序自动创建并回填（用于会话续接） |

## 启动

```bash
# 使用默认配置文件 fed-workflow.yaml
bun run index.ts --config

# 指定配置文件
bun run index.ts --config /path/to/my-config.yaml
```

## 其他命令

```bash
--version    查看版本
--help       查看帮助
--list       查看飞书群组列表（用于获取 chatId）
--init       创建配置文件模板
```

## 工作流程

1. 程序监听飞书群消息
2. 启动时通过群成员 API 预加载用户名字缓存
3. 判断是否为前端开发任务（重点关注 @机器人 的消息）
4. 确认任务后：`send_message` 通知群内领取 → 编辑 `fed-task.md` 追加任务
5. 调用 coder agent 完成编码、commit、push
6. 完成后更新任务状态，`send_message` 发送完成报告和 MR 链接

### 多群并行

- 不同群之间并行执行
- 同一群内串行：前一个任务完成后，合并所有待处理消息（最多 50 条）作为下一轮输入

### 会话续接

- 每个群维护独立的会话，`conversationId` 自动回填到配置文件
- 重启后自动续接上次会话上下文

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `zhipu_token` | 是 | 智谱 API Token |
| `LOG_LEVEL` | 否 | 日志级别，默认 `info`，可选 `debug` |
