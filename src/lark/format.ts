/**
 * 飞书消息格式化
 */
import { larkContentSchema, type LarkContent, type LarkMention } from "./schemas"
import type { UserCache } from "../message/userCache"
import type { LarkMessage } from "./schemas"

/**
 * 将消息列表美化为 markdown
 */
export async function formatMessages(messages: LarkMessage[], userCache: UserCache, chatId?: string): Promise<string> {
  const lines: string[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!.event.message
    const openId = messages[i]!.event.sender.sender_id.open_id
    const name = await userCache.getName(openId, chatId ?? msg.chat_id)
    const time = new Date(Number(msg.create_time)).toLocaleString("zh-CN")
    const chatType = msg.chat_type === "p2p" ? "私聊" : "群聊"
    const content = tryParseContent(messages[i]!.event.message.content, messages[i]!.event.message.mentions)
    lines.push(`### ${i + 1}. [${time}] ${chatType}
- **message_id**: \`${msg.message_id}\`
- **发送者**: ${name}(\`${openId}\`)
- **内容**: ${content}`)
  }
  return lines.join("\n\n")
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
    case "audio": return `[语音消息: ${content.duration}ms](file_key: ${content.file_key})`
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

/**
 * 解析飞书消息内容为纯文本
 * 用于从 LarkMessage 提取可读内容
 */
export function parseLarkContent(raw: string, mentions?: LarkMention[]): string {
  return tryParseContent(raw, mentions)
}
