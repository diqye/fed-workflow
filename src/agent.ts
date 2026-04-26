import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { LarkMessage } from "./const";
import { SYSTEM_PROMPT, AUDIO_HELP } from "./const";
import { zhipuToken } from "./env";
import { fetchChatDetail, fetchMessageResource, sendImageMessage, sendFileMessage, sendAudioMessage, sendMessage, type UserCache } from "./lark";
import { Log } from "./log";
import type { CronManager } from "./cronManager";

/**
 * 飞书工具
 */
function createLarkMcpServer(chatId: string, cronManager: CronManager) {
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
      tool(
        "send_audio",
        "向当前群组发送语音消息（TTS 文本转语音）,支持插入 <#秒数#> — 插入停顿、(laughs) - 大笑。传 help=true 查看完整参数说明",
        {
          help: z.boolean().optional().describe("传 true 查看完整参数说明"),
          text: z.string().optional().describe("要转为语音的文本"),
          emotion: z.string().optional().describe("整体情绪，默认 calm"),
          speed: z.number().optional().describe("语速 0.5-2，默认 1"),
        },
        async (args) => {
          if (args.help) {
            return { content: [{ type: "text" as const, text: AUDIO_HELP }] }
          }
          if (!args.text) {
            return { content: [{ type: "text" as const, text: "缺少 text 参数" }] }
          }
          const result = await sendAudioMessage(chatId, args.text, {
            emotion: args.emotion,
            speed: args.speed,
          })
          return { content: [{ type: "text" as const, text: result }] }
        },
      ),
      tool(
        "cron_create",
        "创建定时任务。将自然语言时间描述转换为 cron 表达式，如'每天早上9点'→'0 9 * * *'、'工作日下午3点'→'0 15 * * 1-5'",
        {
          expression: z.string().describe("cron 表达式，5位：分 时 日 月 周，如 0 9 * * * 表示每天9点"),
          prompt: z.string().describe("触发时发给 agent 的提示文本"),
        },
        async (args) => {
          const task = cronManager.create(chatId, args.expression, args.prompt)
          return { content: [{ type: "text" as const, text: `定时任务已创建: id=${task.id}, expression="${task.expression}", prompt="${task.prompt}"` }] }
        },
      ),
      tool(
        "cron_delete",
        "删除定时任务",
        {
          id: z.string().describe("要删除的定时任务 ID"),
        },
        async (args) => {
          const ok = cronManager.delete(chatId, args.id)
          return { content: [{ type: "text" as const, text: ok ? `定时任务 ${args.id} 已删除` : `定时任务 ${args.id} 不存在` }] }
        },
      ),
      tool(
        "cron_list",
        "列出当前群的所有定时任务",
        {},
        async () => {
          const tasks = cronManager.list(chatId)
          if (tasks.length === 0) {
            return { content: [{ type: "text" as const, text: "当前群没有定时任务" }] }
          }
          const lines = tasks.map(t => `- id: ${t.id}, expression: "${t.expression}", prompt: "${t.prompt}"`)
          return { content: [{ type: "text" as const, text: `当前群定时任务 (${tasks.length})：\n${lines.join("\n")}` }] }
        },
      ),
    ],
  })
}

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
  cronManager: CronManager,
  log: typeof Log
}

export async function run(prompt: string, options: Options): Promise<string> {
  const log = options.log
  log.info("prompt:\n", prompt)
  log.info("start, resume:", String(!!options.conversationId))

  const larkMcp = createLarkMcpServer(options.chatId, options.cronManager)

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
        deny: ["WebSearch", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup"],
      },
      skipWebFetchPreflight: true,
      skipDangerousModePermissionPrompt: true,
    },
  }

  const q = query({ prompt, options: queryOptions })

  let sessionId = ""
  let succeeded = false

  for await (const msg of q) {
    if (msg.type === "result" && msg.subtype === "success") {
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
