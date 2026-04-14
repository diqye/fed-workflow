import { spawn } from "bun";
import { tmpdir } from "os";
import { join } from "path";
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
    const message = JSON.parse(lineText)
    yield larkMessageSchema.parse(message)
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

async function larkApi(method: string, path: string, opts?: { params?: Record<string, string>, data?: string, output?: string, as?: "bot" | "user", cwd?: string }): Promise<string> {
  const identity = opts?.as ?? "bot"
  const cmd = ["lark-cli", "api", method, path, "--as", identity]
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
  const { data } = JSON.parse(raw)
  const lines = [
    `**${data.name}**`,
    `- **类型**: ${data.chat_type === "private" ? "私有" : "公开"}`,
    `- **模式**: ${data.chat_mode === "group" ? "群聊" : "单聊"}`,
    `- **描述**: ${data.description || "无"}`,
    `- **群主**: \`${data.owner_id}\``,
    `- **成员数**: ${data.user_count}`,
    `- **机器人**: ${data.bot_count}`,
  ]
  return lines.join("\n")
}

/**
 * 获取群详情原始数据（供配置自动填充）
 */
export async function fetchChatRaw(chatId: string): Promise<{ name: string; description: string }> {
  const raw = await larkApi("GET", `/open-apis/im/v1/chats/${chatId}`)
  const { data } = JSON.parse(raw)
  return { name: data.name, description: data.description || "" }
}

/**
 * 获取用户详情并格式化为 markdown
 */
export async function fetchUserDetail(openId: string): Promise<string> {
  const raw = await larkApi("GET", `/open-apis/contact/v3/users/${openId}`, {
    params: { user_id_type: "open_id" },
  })
  const { data } = JSON.parse(raw)
  const user = data.user
  const lines = [
    `**${user.name}**`,
    `- **open_id**: \`${user.open_id}\``,
    `- **英文名**: ${user.en_name || "无"}`,
    `- **描述**: ${user.description || "无"}`,
  ]
  return lines.join("\n")
}

/**
 * 获取用户名字（供缓存使用）
 */
async function fetchUserName(openId: string): Promise<string> {
  const raw = await larkApi("GET", `/open-apis/contact/v3/users/${openId}`, {
    params: { user_id_type: "open_id" },
  })
  const { data } = JSON.parse(raw)
  return data.user.name as string
}

/**
 * 创建用户名字缓存，未命中时自动请求 API
 */
export function createUserCache(initial?: Record<string, string>): UserCache {
  const cache = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    async getName(openId: string): Promise<string> {
      const cached = cache.get(openId)
      if (cached) return cached
      const name = await fetchUserName(openId)
      cache.set(openId, name)
      return name
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
 * 下载消息中的图片，返回本地文件路径
 */
export async function fetchMessageImage(messageId: string, imageKey: string): Promise<string> {
  const dir = join(tmpdir(), "lark-images")
  await mkdir(dir, { recursive: true })
  await larkApi("GET", `/open-apis/im/v1/messages/${messageId}/resources/${imageKey}`, {
    params: { type: "image" },
    output: `${imageKey}.png`,
    cwd: dir,
  })
  return join(dir, `${imageKey}.png`)
}

/**
 * 将 @_user_N 占位符替换为实际名称
 */
function resolveMentions(text: string, mentions?: LarkMention[]): string {
  if (!mentions) return text
  let result = text
  for (const m of mentions) {
    result = result.replaceAll(m.key, `@${m.name}`)
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
    case "file": return `[文件:${content.file_name}]`
    case "post": {
      const parts: string[] = []
      if (content.title) parts.push(`**${content.title}**`)
      for (const paragraph of content.content) {
        const line = paragraph.map((el) => {
          switch (el.tag) {
            case "text": return resolveMentions(el.text, mentions)
            case "img": return `[图片:${el.image_key}]`
            case "a": return `[${el.text}](${el.href})`
            case "at": return `@${el.user_name}`
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
