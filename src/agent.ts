import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { LarkMessage } from "./const";
import { formatMessages, fetchChatDetail, fetchUserDetail, fetchMessageImage, sendMessage } from "./lark";
import { Log } from "./log";

/**
 * 将飞书查询函数暴露为 MCP 工具，供 agent 调用
 */
function createLarkMcpServer() {
  return createSdkMcpServer({
    name: "lark",
    version: "1.0.0",
    tools: [
      tool(
        "fetch_chat_detail",
        "获取飞书群组详情，返回群名、类型、描述、成员数等信息",
        { chat_id: z.string().describe("群组 chat_id") },
        async (args) => {
          const result = await fetchChatDetail(args.chat_id)
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
        "向飞书群组发送消息，支持 @人（可突破静音通知）",
        {
          chat_id: z.string().describe("群组 chat_id"),
          text: z.string().describe("要发送的文本内容"),
          mention_open_ids: z.array(z.string()).optional().describe("要 @ 的用户 open_id 列表，@人可突破静音通知"),
        },
        async (args) => {
          const result = await sendMessage(args.chat_id, args.text, args.mention_open_ids)
          return { content: [{ type: "text" as const, text: result }] }
        },
      ),
    ],
  })
}

type Options = {
  chatId: string,
  appendPrompt: string,
  listenContinue: boolean,
  conversationId: string | null,
}

export async function run(messages: LarkMessage[], options: Options): Promise<string> {
  const prompt = formatMessages(messages)
  Log.info("prompt:\n" + prompt)

  const larkMcp = createLarkMcpServer()

  const q = query({
    prompt,
    options: {
      resume: options.conversationId ?? undefined,
      continue: !options.conversationId && options.listenContinue ? true : undefined,
      systemPrompt: options.appendPrompt
        ? { type: "preset", preset: "claude_code", append: options.appendPrompt }
        : undefined,
      mcpServers: { lark: larkMcp },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  })

  let resultText = ""
  let sessionId = ""

  for await (const msg of q) {
    if (msg.type === "result" && msg.subtype === "success") {
      resultText = msg.result
      sessionId = msg.session_id
    }
    if (msg.type === "result" && msg.subtype !== "success") {
      Log.error("agent error:", "errors" in msg ? msg.errors.join(", ") : "unknown")
      sessionId = msg.session_id
    }

    if(msg.type == "assistant") {
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

  Log.info("agent result:", resultText)
  return sessionId
}