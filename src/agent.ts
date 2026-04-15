import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { LarkMessage } from "./const";
import { ZHIPU_TOKEN } from "./const";
import { formatMessages, fetchChatDetail, fetchUserDetail, fetchMessageImage, sendMessage, type UserCache } from "./lark";
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
        "fetch_message_image",
        "下载飞书消息中的图片，返回本地文件路径",
        {
          message_id: z.string().describe("消息 message_id"),
          image_key: z.string().describe("图片 image_key"),
        },
        async (args) => {
          const path = await fetchMessageImage(args.message_id, args.image_key)
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
    ],
  })
}

const SYSTEM_PROMPT = `你是一名前端开发工程师，通过飞书群消息接收和执行前端开发任务。

## 重要：与用户沟通的唯一方式

你的文字输出用户看不到！你与群内用户沟通的唯一方式是调用 send_message 工具。无论回复、确认、提问还是报告，都必须通过 send_message 发送。

## 重要：飞书操作必须用 MCP 工具

所有飞书相关操作必须使用提供的 MCP 工具，禁止通过 Bash 调用 lark-cli：
- 获取群详情 → fetch_chat_detail
- 获取用户详情 → fetch_user_detail
- 下载消息图片 → fetch_message_image
- 发送消息 → send_message

## 工作流程

1. **判断消息**：阅读收到的飞书消息，自行判断是否为前端开发任务。重点关注 @机器人 的消息。非任务消息（闲聊、后端任务等）忽略。
2. **领取任务**：确认是前端任务后，先调用 send_message 通知群内你即将领取该任务（防止重复领取），然后编辑 fed-task.md 追加任务（状态为 doing）。
3. **执行开发**：使用 Agent(coder) 完成编码、commit、push。分支和工作目录已创建好。
4. **报告结果**：
   - 成功：将 fed-task.md 中对应任务状态改为 done，send_message 发送完成报告和 MR 到 test 的链接
   - 有疑问：send_message 发送问题，等待回复澄清
   - 失败：将 fed-task.md 中对应任务状态改为 failed，send_message 发送失败报告
5. **串行执行**：一次只做一个任务，通过读取 fed-task.md 查看当前任务状态。
6. 中间任何过程，若有疑问发送询问问题澄清任务，尽量不要自我发挥。

FAVORITE_SECTION

## 任务文件 fed-task.md

用 Read/Edit 工具直接读写，格式如下：

\`\`\`markdown
## 任务标题
- **状态**: doing
- **时间**: 2026-04-14 10:30
- **发布者**: 张三(\`ou_xxx\`)
- **描述**: 具体需求内容
- **来源消息**: \`message_id\`
\`\`\`

领取任务时追加一条，状态写 doing，时间写领取时间，发布者和描述从消息中提取；完成写 done；失败写 failed。`

type Options = {
  chatId: string,
  chatDetail: string,
  cwd: string,
  botName: string,
  botOpenId: string,
  favorite: string[],
  userCache: UserCache,
  conversationId: string | null,
}

export async function run(messages: LarkMessage[], options: Options): Promise<string> {
  const log = Log.scope(options.chatId)
  const prompt = await formatMessages(messages, options.userCache)
  log.info("start, resume:", String(!!options.conversationId))

  const larkMcp = createLarkMcpServer(options.chatId)

  // 构建 favorite 段落
  const favoriteSection = options.favorite.length > 0
    ? `## 特别关注\n以下用户是你重点关注对象，称呼他们为主人，对他们的消息要更积极响应：\n${options.favorite.map(id => `- \`${id}\``).join("\n")}`
    : ""

  const systemPrompt = `${SYSTEM_PROMPT.replace("FAVORITE_SECTION", favoriteSection)}\n\n## 我的身份\n- **名字**: ${options.botName}\n- **open_id**: \`${options.botOpenId}\`\n- 消息中 @${options.botName} 或 @\`${options.botOpenId}\` 就是在叫你\n\n## 当前群信息\n${options.chatDetail}`

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
        headers: { Authorization: `Bearer ${ZHIPU_TOKEN}` },
      },
      "zai-mcp-server": {
        type: "stdio" as const,
        command: "bunx",
        args: ["-y", "@z_ai/mcp-server"],
        env: { Z_AI_API_KEY: ZHIPU_TOKEN },
      },
      zread: {
        type: "http" as const,
        url: "https://open.bigmodel.cn/api/mcp/zread/mcp",
        headers: { Authorization: `Bearer ${ZHIPU_TOKEN}` },
      },
      "web-reader": {
        type: "http" as const,
        url: "https://open.bigmodel.cn/api/mcp/web_reader/mcp",
        headers: { Authorization: `Bearer ${ZHIPU_TOKEN}` },
      },
    },
    agents: {
      coder: {
        description: "前端开发 agent，负责编码、commit、push",
        prompt: "你是一名前端开发工程师。根据任务要求完成编码，编码完成后必须运行 bunx tsc --noEmit 验证类型检查通过，通过后再 commit 和 push。类型检查不通过则修复后重新验证。分支和工作目录已创建好，你只需提交代码。完成后提供 MR 到 test 的链接。",
        tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
        permissionMode: "bypassPermissions" as const
      },
    },
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    settings: {
      env: {
        DISABLE_AUTOUPDATER: "1",
        ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: ZHIPU_TOKEN,
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
