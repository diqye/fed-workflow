/**
 * Channel 无关的消息类型定义
 */

/** @提及 */
export interface Mention {
  key: string       // 占位符，如 "@_user_1"
  name: string
  id: string
}

/** 标准消息 */
export interface Message {
  id: string
  chatId: string
  chatType: "group" | "private"
  sender: { id: string; name: string }
  /** 已格式化的文本内容；未识别的消息类型用原始文本（可能是 JSON） */
  content: string
  timestamp: number
  mentions: Mention[]
  /** 原始消息，供 channel 特定访问 */
  raw: unknown
  /** 来源 channel 名称，由 ChannelManager 注入 */
  channelName: string
}

/** 发送内容——判别联合 */
export type SendContent =
  | { type: "text"; text: string; mentionIds?: string[]; replyMessageId?: string }
  | { type: "image"; filePath: string }
  | { type: "file"; filePath: string }
  | { type: "audio"; text: string; voiceId?: string; emotion?: string; speed?: number }

/** Channel 能力描述 */
export interface ChannelCapabilities {
  description: string
  systemPrompt: string
}

/** Feed 事件 */
export type FeedEvent =
  | { type: "message"; message: Message }
  | { type: "cron"; chatId: string; prompt: string }
