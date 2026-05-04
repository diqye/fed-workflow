/**
 * 飞书 API 封装
 */
import { spawn } from "bun"
import { Log } from "../log"

export async function larkApi(method: string, path: string, opts?: { params?: Record<string, string>; data?: string; output?: string; cwd?: string }): Promise<string> {
  const cmd = ["lark-cli", "api", method, path, "--as", "bot"]
  if (opts?.params) cmd.push("--params", JSON.stringify(opts.params))
  if (opts?.data) cmd.push("--data", opts.data)
  if (opts?.output) cmd.push("-o", opts.output)
  const proc = spawn({ cmd, stdout: "pipe", stderr: "pipe", cwd: opts?.cwd })
  const text = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`lark-cli api failed: ${err}`)
  }
  return text
}

export async function fetchBotInfo(): Promise<{ name: string; open_id: string }> {
  const raw = await larkApi("GET", "/open-apis/bot/v3/info/")
  const bot = JSON.parse(raw)?.bot
  return { name: bot?.app_name ?? "bot", open_id: bot?.open_id ?? "" }
}

export async function fetchChatList() {
  const raw = await larkApi("GET", "/open-apis/im/v1/chats")
  return JSON.parse(raw)
}

export async function fetchChatDetail(chatId: string): Promise<string> {
  const raw = await larkApi("GET", `/open-apis/im/v1/chats/${chatId}`)
  const data = JSON.parse(raw)?.data
  const lines = [
    `**${data?.name ?? chatId}**`,
    `- **类型**: ${data?.chat_type === "private" ? "私有" : "公开"}`,
    `- **模式**: ${data?.chat_mode === "group" ? "群聊" : "单聊"}`,
    `- **描述**: ${data?.description || "无"}`,
    `- **群主**: \`${data?.owner_id ?? ""}\``,
    `- **成员数**: ${data?.user_count ?? "?"}`,
    `- **机器人**: ${data?.bot_count ?? "?"}`,
  ]
  return lines.join("\n")
}

export async function fetchChatRaw(chatId: string): Promise<{ name: string; description: string }> {
  const raw = await larkApi("GET", `/open-apis/im/v1/chats/${chatId}`)
  const data = JSON.parse(raw)?.data
  return { name: data?.name ?? chatId, description: data?.description ?? "" }
}

export async function fetchChatMembers(chatId: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  let pageToken: string | undefined
  do {
    const params: Record<string, string> = { page_size: "100" }
    if (pageToken) params.page_token = pageToken
    const raw = await larkApi("GET", `/open-apis/im/v1/chats/${chatId}/members`, { params })
    const data = JSON.parse(raw)?.data
    for (const item of data?.items ?? []) {
      if (item.member_id && item.name) {
        result[item.member_id] = item.name
      }
    }
    pageToken = data?.has_more ? data?.page_token : undefined
  } while (pageToken)
  return result
}
