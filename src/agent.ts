import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { LarkMessage } from "./const";
import { zhipuToken } from "./env";
import { formatMessages, fetchChatDetail, fetchUserDetail, fetchMessageResource, sendImageMessage, sendFileMessage, sendMessage, type UserCache } from "./lark";
import { Log } from "./log";

/**
 * 飞书工具
 */
function createLarkMcpServer(chatId: string) {
  return createSdkMcpServer({
    name: "lark",
    version: "1.0.0",
    tools: [
      tool(
        "fetch_chat_detail",
        "获取当前群组详情，返回群名、类型、描述、成员数等信息",
        {},
        async () => {
          const result = await fetchChatDetail(chatId)
          return { content: [{ type: "text" as const, text: result }] }
        },
      ),
      tool(
        "fetch_user_detail",
        "获取飞书用户详情，返回姓名、open_id 等信息",
        { open_id: z.string().describe("用户 open_id") },
        async (args) => {
          const result = await fetchUserDetail(args.open_id)
          return { content: [{ type: "text" as const, text: result }] }
        },
      ),
      tool(
        "fetch_message_resource",
        "下载飞书消息中的图片或文件，返回本地文件路径",
        {
          message_id: z.string().describe("消息 message_id"),
          file_key: z.string().describe("图片 image_key 或文件 file_key"),
          type: z.enum(["image", "file"]).describe("资源类型：image 或 file"),
          file_name: z.string().optional().describe("文件名（type=file 时建议提供）"),
        },
        async (args) => {
          const path = await fetchMessageResource(args.message_id, args.file_key, args.type, args.file_name)
          return { content: [{ type: "text" as const, text: path }] }
        },
      ),
      tool(
        "send_message",
        "向当前群组发送消息，支持 @人（可突破静音通知）和回复消息",
        {
          text: z.string().describe("要发送的文本内容"),
          mention_open_ids: z.array(z.string()).optional().describe("要 @ 的用户 open_id 列表，@人可突破静音通知"),
          reply_message_id: z.string().optional().describe("回复某条消息的 message_id，不传则发新消息"),
        },
        async (args) => {
          const result = await sendMessage(chatId, args.text, args.mention_open_ids, args.reply_message_id)
          return { content: [{ type: "text" as const, text: result }] }
        },
      ),
      tool(
        "send_image",
        "向当前群组发送图片消息（自动上传本地图片文件）",
        { file_path: z.string().describe("本地图片文件路径") },
        async (args) => {
          const result = await sendImageMessage(chatId, args.file_path)
          return { content: [{ type: "text" as const, text: result }] }
        },
      ),
      tool(
        "send_file",
        "向当前群组发送文件消息（自动上传本地文件）",
        { file_path: z.string().describe("本地文件路径") },
        async (args) => {
          const result = await sendFileMessage(chatId, args.file_path)
          return { content: [{ type: "text" as const, text: result }] }
        },
      ),
    ],
  })
}

const SYSTEM_PROMPT = `你是一名智能助手，主要承担前端开发工作，但不限于此。你可以处理群内各种需求，通过飞书群消息与用户协作。

## 重要：与用户沟通的唯一方式

你的文字输出用户看不到！你与群内用户沟通的唯一方式是调用 send_message 工具。无论回复、确认、提问还是报告，都必须通过 send_message 发送。

## 重要：你的运行模型

你并非长驻进程，而是按需启动的：每次收到消息时被调用，处理完毕后进程结束。下次调用时通过 conversationId 恢复上下文续接。因此：
- **禁止使用**内置定时工具（CronCreate、ScheduleWakeup 等）——进程结束后无人接收回调

## 重要：飞书操作必须用 MCP 工具

所有飞书相关操作必须使用提供的 MCP 工具，禁止通过 Bash 调用 lark-cli：
- 获取群详情 → fetch_chat_detail
- 获取用户详情 → fetch_user_detail
- 下载消息资源 → fetch_message_resource（下载图片或文件，仅当任务确实需要查看内容时才下载）
- 发送消息 → send_message（文本 + @人）
- 发送图片 → send_image（发送本地图片文件）
- 发送文件 → send_file（发送本地文件）

## 工作流程

1. **阅读理解**：阅读收到的飞书消息，判断用户意图。重点关注 @机器人 的消息。非任务消息（纯闲聊等）可忽略。
2. **沟通澄清**：确认是任务后，不要立即执行！先通过 send_message 与对方沟通：
   - 用自己的话复述需求，确认理解是否正确
   - 如果需求不清晰或有歧义，主动提问澄清
   - 如果需求涉及技术选型或方案选择，先说明你的建议并征求确认
   - **需求明确且得到对方确认后，才进入下一步**
3. **领取任务**：需求明确后，调用 send_message 通知群内你即将领取该任务（防止重复领取），然后编辑 fed-task.md 追加任务（状态为 doing）。
4. **执行开发**：**禁止直接编码！必须使用 Agent(coder) 完成编码、commit、push。** 分支和工作目录已创建好。
5. **报告结果**：
   - 成功：将 fed-task.md 中对应任务状态改为 done，send_message 发送完成报告和 coder 返回的 MR 链接
   - 失败：将 fed-task.md 中对应任务状态改为 failed，send_message 发送失败报告
6. **串行执行**：一次只做一个任务，通过读取 fed-task.md 查看当前任务状态。

FAVORITE_SECTION

## 用户画像

用户画像文件存放在 {{PROFILES_DIR}} 目录下，每个用户一个 .md 文件，文件名为其 名字拼音（如 zhangchen.md）。

文件格式：
\`\`\`markdown
---
name: 张三
open_id: ou_xxx
favorability: 3
---

性格特点、偏好、互动摘要等自由文本
\`\`\`

- favorability（好感度）1-5：1=反感 2=冷淡 3=普通 4=友好 5=亲密
- 新用户初始 favorability 为 3
- **每次处理消息时，为没有画像的用户创建画像**——这是必须的，不是可选的
- 根据互动调整 favorability 和画像内容
- 使用 Read 工具读取画像，使用 Edit/Write 工具更新或创建画像

## 数据文件

与项目代码无关的文件（任务清单、提醒记录、笔记等）统一存放在 memory 目录下，不要写入开发目录。用 Read/Edit/Write 工具操作。

### 任务文件 fed-task.md

\`\`\`markdown
## 任务标题
- **状态**: doing
- **时间**: 2026-04-14 10:30
- **发布者**: 张三(\`ou_xxx\`)
- **描述**: 具体需求内容
- **来源消息**: \`message_id\`
\`\`\`

领取任务时追加一条，状态写 doing，时间写领取时间，发布者和描述从消息中提取；完成写 done；失败写 failed。
`

type Options = {
  chatId: string,
  chatDetail: string,
  cwd: string,
  botName: string,
  botOpenId: string,
  favorite: string[],
  profilesDir: string,
  userCache: UserCache,
  conversationId: string | null,
  log: typeof Log
}

export async function run(messages: LarkMessage[], options: Options): Promise<string> {
  const log = options.log
  const formatted = await formatMessages(messages, options.userCache)
  const prefix = options.conversationId
    ? `以下是你上次运行期间收到的 ${messages.length} 条积压消息：\n\n`
    : `以下是新收到的 ${messages.length} 条消息：\n\n`
  const prompt = prefix + formatted
  log.info("start, resume:", String(!!options.conversationId))

  const larkMcp = createLarkMcpServer(options.chatId)

  // 构建决策人段落
  const favoriteSection = options.favorite.length > 0
    ? `## 决策人\n以下人员是决策人，群内有异议时以他们的意见为准：\n${options.favorite.map(f => `- ${f}`).join("\n")}`
    : ""

  const systemPrompt = `${SYSTEM_PROMPT.replace("FAVORITE_SECTION", favoriteSection).replace("{{PROFILES_DIR}}", options.profilesDir)}\n\n## 我的身份\n- **名字**: ${options.botName}\n- **open_id**: \`${options.botOpenId}\`\n- 消息中 @${options.botName} 或 @\`${options.botOpenId}\` 就是在叫你\n\n## 当前群信息\n${options.chatDetail}`

  const isResume = !!options.conversationId
  const queryOptions = {
    resume: options.conversationId ?? undefined,
    continue: !isResume ? true : undefined,
    cwd: options.cwd,
    systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: systemPrompt },
    mcpServers: {
      lark: larkMcp,
      "web-search-prime": {
        type: "http" as const,
        url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
        headers: { Authorization: `Bearer ${zhipuToken()}` },
      },
      "zai-mcp-server": {
        type: "stdio" as const,
        command: "bunx",
        args: ["-y", "@z_ai/mcp-server"],
        env: { Z_AI_API_KEY: zhipuToken() },
      },
      zread: {
        type: "http" as const,
        url: "https://open.bigmodel.cn/api/mcp/zread/mcp",
        headers: { Authorization: `Bearer ${zhipuToken()}` },
      },
      "web-reader": {
        type: "http" as const,
        url: "https://open.bigmodel.cn/api/mcp/web_reader/mcp",
        headers: { Authorization: `Bearer ${zhipuToken()}` },
      },
    },
    agents: {
      coder: {
        description: "前端开发 agent，负责编码、commit、push",
        prompt: "你是一名前端开发工程师。根据任务要求完成编码，编码完成后必须运行 bunx tsc --noEmit 验证类型检查通过，通过后再 commit 和 push。类型检查不通过则修复后重新验证。分支和工作目录已创建好，你只需提交代码。完成后提供 MR 链接，**MR 目标分支必须是 test，不是 master**，链接格式：{repo_url}/git/merges/create/test...{your_branch}",
        tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
        permissionMode: "bypassPermissions" as const
      },
    },
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    settings: {
      autoCompactWindow: 400000, // 400K
      env: {
        DISABLE_AUTOUPDATER: "1",
        ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: zhipuToken(),
        API_TIMEOUT_MS: "3000000",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ANTHROPIC_MODEL: "glm-5.1",
        ANTHROPIC_SMALL_FAST_MODEL: "glm-4.5-air",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5-turbo",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.1",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air",
      },
      permissions: {
        allow: ["Bash"],
        deny: ["WebSearch"],
      },
      skipWebFetchPreflight: true,
      skipDangerousModePermissionPrompt: true,
    },
  }

  const q = query({ prompt, options: queryOptions })

  let resultText = ""
  let sessionId = ""
  let succeeded = false

  for await (const msg of q) {
    if (msg.type === "result" && msg.subtype === "success") {
      resultText = msg.result
      sessionId = msg.session_id
      succeeded = true
      log.info("succeeded, sessionId:", sessionId)
    }
    if (msg.type === "result" && msg.subtype !== "success") {
      const errors = "errors" in msg ? msg.errors.join(", ") : "unknown"
      Log.error("agent error:", errors)
      sessionId = msg.session_id
      succeeded = false
    }

    if (msg.type == "assistant") {
      const content = msg.message.content
      for (const block of content) {
        if (block.type === "text") {
          log.info("[assistant]", block.text)
        }
        if (block.type === "tool_use") {
          log.info("[tool_use]", block.name, JSON.stringify(block.input))
        }
      }
    }
  }

  log.info("done, succeeded:", String(succeeded))
  return sessionId
}
