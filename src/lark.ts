import { spawn } from "bun";
import { tmpdir } from "os";
import { join, parse } from "path";
import { mkdir } from "fs/promises";
import { Log } from "./log";
import { larkContentSchema, larkMessageSchema, type LarkMessage, type LarkContent, type LarkMention } from "./const";

/**
 * 飞书消息事件
 */


/**
 * 监听飞书消息
 */
/**
 * 杀掉已有的 lark-cli event +subscribe 进程
 */
function killExistingSubscriber() {
  try {
    const result = Bun.spawnSync([
      "pkill", "-f", "lark-cli event \\+subscribe"
    ])
    if (result.exitCode === 0) {
      Log.error("[killExistingSubscriber] 已杀掉旧实例")
    }
  } catch {}
}

export async function* listenLarkMessages() {
  killExistingSubscriber()
  const proc = spawn({
    cmd: [
      "lark-cli",
      "event",
      "+subscribe",
      "--event-types", "im.message.receive_v1",
      "--quiet",
      "--as","bot"
    ],
    stdout: "pipe",
    stderr: "inherit",
  });

  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read()
    if (done) break;

    const lineText = decoder.decode(value)
    Log.debug("[listenLarkMessages]",lineText)
    try {
      const message = JSON.parse(lineText)
      if (message.header?.event_type !== "im.message.receive_v1") continue
      yield larkMessageSchema.parse(message)
    } catch (e:any) {
      Log.error("[listenLarkMessages]",e.message)
    }
  }

  await proc.exited;
}

export type UserCache = { getName(openId: string): Promise<string> }

/**
 * 将消息列表美化为 markdown
 */
export async function formatMessages(messages: LarkMessage[], userCache: UserCache): Promise<string> {
  const lines = await Promise.all(messages.map(async (m, i) => {
    const msg = m.event.message
    const openId = m.event.sender.sender_id.open_id
    const name = await userCache.getName(openId)
    const time = new Date(Number(msg.create_time)).toLocaleString("zh-CN")
    const chatType = msg.chat_type === "p2p" ? "私聊" : "群聊"
    const content = tryParseContent(msg.content, msg.mentions)
    return `### ${i + 1}. [${time}] ${chatType}
- **message_id**: \`${msg.message_id}\`
- **发送者**: ${name}(\`${openId}\`)
- **内容**: ${content}`
  }))
  return lines.join("\n\n")
}

async function larkApi(method: string, path: string, opts?: { params?: Record<string, string>, data?: string, output?: string, cwd?: string }): Promise<string> {
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

/**
 * 获取机器人自身信息
 */
export async function fetchBotInfo(): Promise<{ name: string; open_id: string }> {
  const raw = await larkApi("GET", "/open-apis/bot/v3/info/")
  const bot = JSON.parse(raw)?.bot
  return { name: bot?.app_name ?? "bot", open_id: bot?.open_id ?? "" }
}

/**
 * 获取群组列表
 */
export async function fetchChatList() {
  const raw = await larkApi("GET", "/open-apis/im/v1/chats")
  return JSON.parse(raw)
}

/**
 * 获取群详情并格式化为 markdown
 */
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

/**
 * 获取群详情原始数据（供配置自动填充）
 */
export async function fetchChatRaw(chatId: string): Promise<{ name: string; description: string }> {
  const raw = await larkApi("GET", `/open-apis/im/v1/chats/${chatId}`)
  const data = JSON.parse(raw)?.data
  return { name: data?.name ?? chatId, description: data?.description ?? "" }
}

/**
 * 获取用户详情并格式化为 markdown
 */
export async function fetchUserDetail(openId: string): Promise<string> {
  const raw = await larkApi("GET", `/open-apis/contact/v3/users/${openId}`, {
    params: { user_id_type: "open_id" },
  })
  const data = JSON.parse(raw)?.data
  const user = data?.user
  const lines = [
    `**${user?.name ?? openId}**`,
    `- **open_id**: \`${user?.open_id ?? openId}\``,
    `- **英文名**: ${user?.en_name || "无"}`,
    `- **描述**: ${user?.description || "无"}`,
  ]
  return lines.join("\n")
}

/**
 * 获取群成员列表（bot 身份），返回 open_id → name 映射
 */
export async function fetchChatMembers(chatId: string): Promise<Record<string, string>> {
  const raw = await larkApi("GET", `/open-apis/im/v1/chats/${chatId}/members`)
  const data = JSON.parse(raw)?.data
  const result: Record<string, string> = {}
  for (const item of data?.items ?? []) {
    if (item.member_id && item.name) {
      result[item.member_id] = item.name
    }
  }
  return result
}

/**
 * 创建用户名字缓存，未命中时返回 open_id
 */
export function createUserCache(initial?: Record<string, string>): UserCache & { put(map: Record<string, string>): void } {
  const cache = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    async getName(openId: string): Promise<string> {
      const cached = cache.get(openId)
      if (cached) return cached
      return openId
    },
    put(map: Record<string, string>) {
      for (const [k, v] of Object.entries(map)) cache.set(k, v)
    },
  }
}

/**
 * 向飞书群/用户发送消息，支持 @人 和回复
 * @param chatId 群组 chat_id
 * @param text 文本内容
 * @param mentionOpenIds 要 @ 的用户 open_id 列表（会突破静音通知）
 * @param replyMessageId 回复某条消息的 message_id，不传则发新消息
 */
export async function sendMessage(chatId: string, text: string, mentionOpenIds: string[] = [], replyMessageId?: string): Promise<string> {
  const content = buildPostContent(text, mentionOpenIds)
  const body = {
    msg_type: "post",
    content: JSON.stringify(content),
  }

  if (replyMessageId) {
    const raw = await larkApi("POST", `/open-apis/im/v1/messages/${replyMessageId}/reply`, {
      data: JSON.stringify(body),
    })
    const { data } = JSON.parse(raw)
    return `已回复消息 ${data.message_id}`
  }

  const raw = await larkApi("POST", "/open-apis/im/v1/messages", {
    params: { receive_id_type: "chat_id" },
    data: JSON.stringify({ receive_id: chatId, ...body }),
  })
  const { data } = JSON.parse(raw)
  return `已发送消息 ${data.message_id}`
}

function buildPostContent(text: string, mentionOpenIds: string[]) {
  const paragraph: unknown[] = []

  for (const openId of mentionOpenIds) {
    paragraph.push({ tag: "at", user_id: openId })
  }

  if (text) {
    paragraph.push({ tag: "text", text })
  }

  return { zh_cn: { title: "", content: [paragraph] } }
}

/**
 * 发送图片消息（本地文件自动上传）
 */
export async function sendImageMessage(chatId: string, filePath: string): Promise<string> {
  const { dir, base } = parse(filePath)
  const proc = spawn({
    cmd: ["lark-cli", "im", "+messages-send", "--chat-id", chatId, "--image", base, "--as", "bot"],
    stdout: "pipe",
    stderr: "pipe",
    cwd: dir || ".",
  })
  const text = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`send image message failed: ${err}`)
  }
  const { data } = JSON.parse(text)
  return `已发送图片消息 ${data.message_id}`
}

/**
 * 发送文件消息（本地文件自动上传）
 */
export async function sendFileMessage(chatId: string, filePath: string): Promise<string> {
  const { dir, base } = parse(filePath)
  const proc = spawn({
    cmd: ["lark-cli", "im", "+messages-send", "--chat-id", chatId, "--file", base, "--as", "bot"],
    stdout: "pipe",
    stderr: "pipe",
    cwd: dir || ".",
  })
  const text = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`send file message failed: ${err}`)
  }
  const { data } = JSON.parse(text)
  return `已发送文件消息 ${data.message_id}`
}

/**
 * 下载消息中的资源（图片/文件），返回本地文件路径
 */
export async function fetchMessageResource(messageId: string, fileKey: string, type: "image" | "file", fileName?: string): Promise<string> {
  const dir = join(tmpdir(), `lark-${type}s`)
  await mkdir(dir, { recursive: true })
  const output = fileName ?? `${fileKey}.${type === "image" ? "png" : "bin"}`
  await larkApi("GET", `/open-apis/im/v1/messages/${messageId}/resources/${fileKey}`, {
    params: { type },
    output,
    cwd: dir,
  })
  return join(dir, output)
}

/**
 * 将 @_user_N 占位符替换为实际名称
 */
function resolveMentions(text: string, mentions?: LarkMention[]): string {
  if (!mentions) return text
  let result = text
  for (const m of mentions) {
    result = result.replaceAll(m.key, `@${m.name}(\`${m.id.open_id}\`)`)
  }
  return result
}

function tryParseContent(raw: string, mentions?: LarkMention[]): string {
  try {
    const obj = JSON.parse(raw)
    const result = larkContentSchema.safeParse(obj)
    if (!result.success) return raw
    return formatContent(result.data, mentions)
  } catch {
    return raw
  }
}

function formatContent(content: LarkContent, mentions?: LarkMention[]): string {
  switch (content.type) {
    case "text": return resolveMentions(content.text, mentions)
    case "image": return `[图片:${content.image_key}]`
    case "file": return `[文件:${content.file_name}](file_key: ${content.file_key})`
    case "post": {
      const parts: string[] = []
      if (content.title) parts.push(`**${content.title}**`)
      for (const paragraph of content.content) {
        const line = paragraph.map((el) => {
          switch (el.tag) {
            case "text": return resolveMentions(el.text, mentions)
            case "img": return `[图片:${el.image_key}]`
            case "a": return `[${el.text}](${el.href})`
            case "at": {
              const mention = mentions?.find(m => m.key === el.user_id)
              if (mention) return `@${mention.name}(\`${mention.id.open_id}\`)`
              return `@${el.user_name || el.user_id}`
            }
          }
        }).join("")
        parts.push(line)
      }
      return parts.join("\n")
    }
  }
}

/*
 * for await (const messages of debounceMessages()) {
 *   // 3s 内无新消息才走到这里
 * }
 */
export async function* debounceMessages(delay = 3000) {
  let staged: LarkMessage[] = []
  let wake: (() => void) | null = null

  // 后台持续收集消息，不受 yield 暂停影响
  ;(async () => {
    for await (const message of listenLarkMessages()) {
      staged.push(message)
      const w = wake as (() => void) | null
      wake = null
      w?.()
    }
  })()

  while (true) {
    // 等待至少一条消息
    if (staged.length === 0) {
      await new Promise<void>((r) => { wake = r })
    }

    // debounce: delay 内无新消息则就绪
    while (true) {
      const len = staged.length
      await new Promise<void>((r) => setTimeout(r, delay))
      if (staged.length === len) break
    }

    const messages = staged
    staged = []
    yield messages
  }
}
