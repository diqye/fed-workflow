import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { LarkMessage } from "./const";
import { ZHIPU_TOKEN } from "./const";
import { formatMessages, fetchChatDetail, fetchUserDetail, fetchMessageImage, sendMessage } from "./lark";
import { readTasks, addTask, updateTaskStatus } from "./task";
import { Log } from "./log";

/**
 * 飞书工具 + 任务管理工具
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
      tool(
        "read_tasks",
        "读取当前任务列表（fed-task.md）",
        {},
        async () => {
          const tasks = await readTasks()
          return { content: [{ type: "text" as const, text: JSON.stringify(tasks, null, 2) }] }
        },
      ),
      tool(
        "add_task",
        "领取任务，添加到 fed-task.md（状态自动管理，无需手动更新）",
        {
          title: z.string().describe("任务标题"),
          source_message_id: z.string().describe("来源消息的 message_id"),
        },
        async (args) => {
          await addTask({ title: args.title, status: "doing", source_message_id: args.source_message_id })
          return { content: [{ type: "text" as const, text: `任务已领取: ${args.title}` }] }
        },
      ),
    ],
  })
}

const SYSTEM_PROMPT = `你是一名前端开发工程师，通过飞书群消息接收和执行前端开发任务。

## 工作流程

1. **判断消息**：阅读收到的飞书消息，自行判断是否为前端开发任务。重点关注 @机器人 和 @秦振龙 的消息。非任务消息（闲聊、后端任务等）忽略。
2. **领取任务**：确认是前端任务后，调用 add_task 领取任务（状态自动为 doing），然后调用 send_message 通知群内你已领取该任务。
3. **执行开发**：使用 Agent(coder) 完成编码、commit、push。分支和工作目录已创建好。
4. **报告结果**：
   - 成功：send_message 发送完成报告和 MR 到 test 的链接
   - 有疑问：send_message 发送问题，等待回复澄清
   - 失败：send_message 发送失败报告
5. **串行执行**：一次只做一个任务，通过 read_tasks 查看当前任务状态。

注意：任务状态由系统自动管理，你无需手动更新状态。`

type Options = {
  chatId: string,
  listenContinue: boolean,
  conversationId: string | null,
}

export async function run(messages: LarkMessage[], options: Options): Promise<string> {
  const prompt = formatMessages(messages)
  Log.info("prompt:\n" + prompt)

  // 记录运行前的 doing 任务，用于运行后对比
  const doingIdsBefore = new Set((await readTasks()).filter(t => t.status === "doing").map(t => t.source_message_id))

  const larkMcp = createLarkMcpServer(options.chatId)

  const q = query({
    prompt,
    options: {
      resume: options.conversationId ?? undefined,
      continue: !options.conversationId && options.listenContinue ? true : undefined,
      systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_PROMPT },
      mcpServers: {
        lark: larkMcp,
        "web-search-prime": {
          type: "http",
          url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
          headers: { Authorization: `Bearer ${ZHIPU_TOKEN}` },
        },
        "zai-mcp-server": {
          type: "stdio",
          command: "bunx",
          args: ["-y", "@z_ai/mcp-server"],
          env: { Z_AI_API_KEY: ZHIPU_TOKEN },
        },
        zread: {
          type: "http",
          url: "https://open.bigmodel.cn/api/mcp/zread/mcp",
          headers: { Authorization: `Bearer ${ZHIPU_TOKEN}` },
        },
        "web-reader": {
          type: "http",
          url: "https://open.bigmodel.cn/api/mcp/web_reader/mcp",
          headers: { Authorization: `Bearer ${ZHIPU_TOKEN}` },
        },
      },
      agents: {
        coder: {
          description: "前端开发 agent，负责编码、commit、push",
          prompt: "你是一名前端开发工程师。根据任务要求完成编码，编码完成后必须运行 bunx tsc --noEmit 验证类型检查通过，通过后再 commit 和 push。类型检查不通过则修复后重新验证。分支和工作目录已创建好，你只需提交代码。完成后提供 MR 到 test 的链接。",
          tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
        },
      },
      permissionMode: "bypassPermissions",
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
    },
  })

  let resultText = ""
  let sessionId = ""
  let succeeded = false

  for await (const msg of q) {
    if (msg.type === "result" && msg.subtype === "success") {
      resultText = msg.result
      sessionId = msg.session_id
      succeeded = true
    }
    if (msg.type === "result" && msg.subtype !== "success") {
      Log.error("agent error:", "errors" in msg ? msg.errors.join(", ") : "unknown")
      sessionId = msg.session_id
      succeeded = false
    }

    if (msg.type == "assistant") {
      const content = msg.message.content
      for (const block of content) {
        if (block.type === "text") {
          Log.info("[assistant]", block.text)
        }
        if (block.type === "tool_use") {
          Log.info("[tool_use]", block.name, JSON.stringify(block.input))
        }
      }
    }
  }

  // 自动收尾：本次新增的 doing 任务 → done/failed
  const tasksAfter = await readTasks()
  const newDoingTasks = tasksAfter.filter(t => t.status === "doing" && !doingIdsBefore.has(t.source_message_id))
  const finalStatus = succeeded ? "done" : "failed"
  for (const task of newDoingTasks) {
    Log.info(`[auto] 任务 "${task.title}" 标记为 ${finalStatus}`)
    await updateTaskStatus(task.source_message_id, finalStatus)
  }

  Log.info("agent result:", resultText)
  return sessionId
}
