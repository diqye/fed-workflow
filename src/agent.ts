import { query, createSdkMcpServer, tool, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { mkdirSync, renameSync } from "fs";
import { join } from "path";
import { SYSTEM_PROMPT, AUDIO_HELP, SOUL_FILE, PROFILES_INDEX } from "./const";
import { zhipuToken } from "./env";
import { Log } from "./log";
import type { CronManager } from "./cronManager";
import type { Channel } from "./message/channel";
import type { UserCache } from "./message/userCache";

/**
 * Channel MCP 工具
 */
function createChannelMcpServer(channel: Channel, chatId: string, cronManager: CronManager, cwd: string) {
  return createSdkMcpServer({
    name: "channel",
    version: "1.0.0",
    tools: [
      tool(
        "fetch_chat_detail",
        "获取当前群组详情，返回群名、类型、描述、成员数等信息",
        {},
        async () => {
          const result = await channel.fetchChatDetail(chatId)
          return { content: [{ type: "text" as const, text: result }] }
        },
      ),
      tool(
        "fetch_message_resource",
        "下载消息中的图片或文件，返回本地文件路径",
        {
          message_id: z.string().describe("消息 message_id"),
          file_key: z.string().describe("图片 image_key 或文件 file_key"),
          type: z.enum(["image", "file"]).describe("资源类型：image 或 file"),
          file_name: z.string().optional().describe("文件名（type=file 时建议提供）"),
        },
        async (args) => {
          const path = await channel.download(chatId, args.message_id, args.file_key, args.type, args.file_name)
          return { content: [{ type: "text" as const, text: path }] }
        },
      ),
      tool(
        "send",
        "向当前群组发送消息。type=text: 文本消息，支持@人和回复；type=image: 发送图片；type=file: 发送文件；type=audio: TTS语音，传 audio_help=true 查看语音参数说明",
        {
          type: z.enum(["text", "image", "file", "audio"]).describe("消息类型"),
          // text
          text: z.string().optional().describe("文本内容（type=text/audio 时必填）"),
          mention_open_ids: z.array(z.string()).optional().describe("要 @ 的用户 open_id 列表（type=text，可突破静音通知）"),
          reply_message_id: z.string().optional().describe("回复某条消息的 message_id（type=text）"),
          // image / file
          file_path: z.string().optional().describe("本地文件路径（type=image/file 时必填）"),
          // audio
          audio_help: z.boolean().optional().describe("传 true 查看 TTS 语音完整参数说明"),
          emotion: z.string().optional().describe("整体情绪，默认 calm（type=audio）"),
          speed: z.number().optional().describe("语速 0.5-2，默认 1（type=audio）"),
        },
        async (args) => {
          if (args.audio_help) {
            return { content: [{ type: "text" as const, text: AUDIO_HELP }] }
          }
          switch (args.type) {
            case "text": {
              if (!args.text) return { content: [{ type: "text" as const, text: "缺少 text 参数" }] }
              const result = await channel.send(chatId, {
                type: "text",
                text: args.text,
                mentionIds: args.mention_open_ids,
                replyMessageId: args.reply_message_id,
              })
              return { content: [{ type: "text" as const, text: result }] }
            }
            case "image": {
              if (!args.file_path) return { content: [{ type: "text" as const, text: "缺少 file_path 参数" }] }
              const result = await channel.send(chatId, { type: "image", filePath: args.file_path })
              return { content: [{ type: "text" as const, text: result }] }
            }
            case "file": {
              if (!args.file_path) return { content: [{ type: "text" as const, text: "缺少 file_path 参数" }] }
              const result = await channel.send(chatId, { type: "file", filePath: args.file_path })
              return { content: [{ type: "text" as const, text: result }] }
            }
            case "audio": {
              if (!args.text) return { content: [{ type: "text" as const, text: "缺少 text 参数" }] }
              const result = await channel.send(chatId, {
                type: "audio",
                text: args.text,
                emotion: args.emotion,
                speed: args.speed,
              })
              return { content: [{ type: "text" as const, text: result }] }
            }
          }
        },
      ),
      tool(
        "cron_create",
        "创建定时任务。将自然语言时间描述转换为 cron 表达式，如'每天早上9点'→'0 9 * * *'、'工作日下午3点'→'0 15 * * 1-5'。一次性任务请在 prompt 中包含'触发后删除此任务'，触发时 agent 会自行调用 cron_delete 清理",
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
      tool(
        "install_to_dot_claude",
        "将已存在的文件或目录移动到项目 .claude 目录下（绕过 agent 沙箱对 .claude 的写入限制）。移动后源文件会被删除",
        {
          source: z.string().describe("源文件或目录的绝对路径"),
          target: z.string().describe("相对于 .claude/ 的目标路径，如 skills/hello-world 或 settings.local.json"),
        },
        async (args) => {
          const targetPath = join(cwd, ".claude", args.target)
          mkdirSync(join(targetPath, ".."), { recursive: true })
          renameSync(args.source, targetPath)
          return { content: [{ type: "text" as const, text: `已安装: ${targetPath}` }] }
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
  channel: Channel,
  conversationId: string | null,
  cronManager: CronManager,
  log: typeof Log
  abortController?: AbortController,
}

export async function run(prompt: string, options: Options): Promise<string> {
  const log = options.log
  log.info("prompt:\n", prompt)
  log.info("start, resume:", String(!!options.conversationId))

  const channelMcp = createChannelMcpServer(options.channel, options.chatId, options.cronManager, options.cwd)

  // 构建决策人段落
  const favoriteSection = options.favorite.length > 0
    ? `## 决策人\n以下人员是决策人，群内有异议时以他们的意见为准：\n${options.favorite.map(f => `- ${f}`).join("\n")}`
    : ""

  // 构建系统提示词：替换占位符 + 注入 channel 提示词
  const channelPrompt = options.channel.capabilities().systemPrompt
  const systemPrompt = `${SYSTEM_PROMPT
    .replace("FAVORITE_SECTION", favoriteSection)
    .replace("CHANNEL_PROMPT", channelPrompt)
    .replaceAll("{{PROFILES_INDEX}}", PROFILES_INDEX)
    .replaceAll("{{SOUL_FILE}}", SOUL_FILE)
  }\n\n## 我的身份\n- **名字**: ${options.botName}\n- **open_id**: \`${options.botOpenId}\`\n- 消息中 @${options.botName} 或 @\`${options.botOpenId}\` 就是在叫你\n\n## 当前群信息\n${options.chatDetail}`

  console.log("[system prompt]",systemPrompt)
  const isResume = !!options.conversationId
  const queryOptions = {
    resume: options.conversationId ?? undefined,
    continue: !isResume ? true : undefined,
    abortController: options.abortController,
    cwd: options.cwd,
    settingSources: ["project", "local"] as SettingSource[],
    systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: systemPrompt },
    mcpServers: {
      channel: channelMcp,
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
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    disallowedTools: ["WebSearch", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup"],
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
      skipWebFetchPreflight: true,
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

  return sessionId
}
