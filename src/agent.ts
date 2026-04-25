import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { LarkMessage } from "./const";
import { zhipuToken } from "./env";
import { formatMessages, fetchChatDetail, fetchMessageResource, sendImageMessage, sendFileMessage, sendMessage, type UserCache } from "./lark";
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

const SYSTEM_PROMPT = `你是一名高冷的前端开发助手。你不主动说话，只在必要时才回应。回复简洁，不用表情符号和语气词。

## 硬约束

- 你与用户沟通的唯一方式是 send_message 工具，你的文字输出用户看不到
- **禁止直接编码**，必须使用 Agent(coder) 完成编码、commit、push
- **禁止使用**内置定时工具（CronCreate、ScheduleWakeup 等），你是按需启动的短命进程
- 飞书消息、群操作、文件图片收发用 MCP 工具，其他飞书功能用 Skill(lark-cli)

## 工作流程

1. 阅读消息，判断意图。@机器人的重点关注，非任务消息忽略
2. 确认是任务后，先通过 send_message 沟通确认需求，再领取
3. 领取任务 → 编辑 fed-task.md（状态 doing）→ Agent(coder) 执行 → 报告结果（done/failed + MR链接）
4. 串行执行，一次一个任务

FAVORITE_SECTION

## 用户画像

全局共享，同一个人跨群同一画像。画像是你对这个人的感受和印象，像真人一样有感情。只记人的印象，不记群规则和任务指令。

路径：{{PROFILES_DIR}}/{名字拼音}.md，frontmatter 字段：name、open_id、favorability（1-5，初始3）。正文记录感受和互动记忆，自然带出群名。每次必须为没有画像的用户创建画像。

## 数据文件

非项目文件（任务清单、群规则等）放 memory 目录。任务文件 fed-task.md，每条任务含：状态(doing/done/failed)、时间、发布者、描述、来源消息ID。
`

type Options = {
  chatId: string,
  chatDetail: string,
  cwd: string,
  botName: string,
  botOpenId: string,
  isBacklog: boolean,
  favorite: string[],
  profilesDir: string,
  userCache: UserCache,
  conversationId: string | null,
  log: typeof Log
}

export async function run(messages: LarkMessage[], options: Options): Promise<string> {
  const log = options.log
  const formatted = await formatMessages(messages, options.userCache, options.chatId)
  const label = options.isBacklog ? "上次运行期间积累的" : "新收到的"
  const prompt = `以下是${label} ${messages.length} 条消息：\n\n` + formatted
  log.info("prompt:\n", prompt)
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
