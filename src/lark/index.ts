/**
 * LarkImpl — 飞书 Channel 实现
 */
import type { ChannelImpl, ChannelInfo, ChatInfo, ChatListItem, Channel } from "../message/channel"
import type { Message, Mention, SendContent, ChannelCapabilities } from "../message/types"
import type { UserCache } from "../message/userCache"
import { createChannelUserCache } from "../message/userCache"
import { listenLarkMessages } from "./listen"
import { parseLarkContent } from "./format"
import { formatMessages } from "./format"
import { fetchBotInfo as _fetchBotInfo, fetchChatList as _fetchChatList, fetchChatDetail as _fetchChatDetail, fetchChatRaw as _fetchChatRaw, fetchChatMembers as _fetchChatMembers } from "./api"
import { sendMessage as _sendMessage, sendImageMessage as _sendImageMessage, sendFileMessage as _sendFileMessage, sendAudioMessage as _sendAudioMessage, fetchMessageResource as _fetchMessageResource } from "./send"
import type { LarkMessage } from "./schemas"
import { Channel as ChannelClass } from "../message/channel"

export class LarkImpl implements ChannelImpl {
  prefix = "lark"
  private userCache: UserCache
  private chatNames = new Map<string, string>()

  constructor(channel: Channel) {
    this.userCache = createChannelUserCache(channel, {}, this.chatNames)
  }

  async *listen(): AsyncGenerator<Message> {
    for await (const raw of listenLarkMessages()) {
      yield this.convertMessage(raw)
    }
  }

  private convertMessage(raw: LarkMessage): Message {
    const msg = raw.event.message
    const sender = raw.event.sender
    const rawChatId = msg.chat_id
    const mentions: Mention[] = (msg.mentions ?? []).map(m => ({
      key: m.key,
      name: m.name,
      id: m.id.open_id,
    }))
    return {
      id: msg.message_id,
      chatId: ChannelClass.buildChatId(this.prefix, rawChatId),
      chatType: msg.chat_type === "p2p" ? "private" : "group",
      sender: {
        id: sender.sender_id.open_id,
        name: sender.sender_id.open_id,
      },
      content: parseLarkContent(msg.content, msg.mentions),
      timestamp: Number(msg.create_time),
      mentions,
      raw,
      channelName: this.prefix,
    }
  }

  async send(rawChatId: string, content: SendContent): Promise<string> {
    switch (content.type) {
      case "text":
        return _sendMessage(rawChatId, content.text, content.mentionIds ?? [], content.replyMessageId)
      case "image":
        return _sendImageMessage(rawChatId, content.filePath)
      case "file":
        return _sendFileMessage(rawChatId, content.filePath)
      case "audio":
        return _sendAudioMessage(rawChatId, content.text, {
          voice_id: content.voiceId,
          emotion: content.emotion,
          speed: content.speed,
        })
    }
  }

  async download(messageId: string, fileId: string, type: "image" | "file", fileName?: string): Promise<string> {
    return _fetchMessageResource(messageId, fileId, type, fileName)
  }

  capabilities(): ChannelCapabilities {
    return {
      description: "飞书群聊：消息收发、图片文件、语音、定时任务",
      systemPrompt: `- 飞书消息、群操作、文件图片收发用 MCP 工具，其他飞书功能用 Skill(lark-cli)
- 读飞书文档用 docs +fetch（返回完整 block 结构含图片），不要用 raw_content（丢图片）`,
    }
  }

  async fetchBotInfo(): Promise<ChannelInfo> {
    const info = await _fetchBotInfo()
    return { name: info.name, id: info.open_id }
  }

  async fetchChatInfo(rawChatId: string): Promise<ChatInfo> {
    return _fetchChatRaw(rawChatId)
  }

  async fetchChatDetail(rawChatId: string): Promise<string> {
    return _fetchChatDetail(rawChatId)
  }

  async fetchChatList(): Promise<ChatListItem[]> {
    const raw = await _fetchChatList()
    const items: { name: string; chat_id: string }[] = raw?.data?.items ?? []
    return items.map(item => ({
      name: item.name,
      chatId: ChannelClass.buildChatId(this.prefix, item.chat_id),
    }))
  }

  async fetchChatMembers(rawChatId: string): Promise<Record<string, string>> {
    return _fetchChatMembers(rawChatId)
  }

  async formatMessages(messages: Message[], userCache: UserCache, chatId?: string): Promise<string> {
    const larkMessages = messages.map(m => m.raw as LarkMessage)
    const rawChatId = chatId ? ChannelClass.parseChatId(chatId).rawId : undefined
    return formatMessages(larkMessages, userCache, rawChatId)
  }

  getUserCache(): UserCache {
    return this.userCache
  }

  /** 补充 chatName 映射（启动时调用） */
  setChatNames(map: Map<string, string>): void {
    for (const [k, v] of map) {
      this.chatNames.set(k, v)
    }
  }
}
