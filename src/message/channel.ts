/**
 * Channel 层：支持多个实现，chatId 统一加前缀避免冲突
 */
import type { CronManager } from "../cronManager"
import type { WebhookManager } from "../webhookManager"
import type { Message, SendContent, ChannelCapabilities, FeedEvent } from "./types"
import type { UserCache } from "./userCache"

export interface ChannelInfo {
  name: string
  id: string
}

export interface ChatInfo {
  name: string
  description: string
}

export interface ChatListItem {
  name: string
  chatId: string
}

/** Channel 实现——如 LarkImpl、SlackImpl */
export interface ChannelImpl {
  /** 前缀，用于 chatId 去重，如 "lark"、"slack" */
  prefix: string
  /** 监听消息，chatId 需加前缀：`${prefix}:${rawChatId}` */
  listen(): AsyncGenerator<Message>
  /** 发送消息，接收不带前缀的 rawChatId */
  send(rawChatId: string, content: SendContent): Promise<string>
  /** 下载资源 */
  download(messageId: string, fileId: string, type: "image" | "file", fileName?: string): Promise<string>
  /** 能力描述 */
  capabilities(): ChannelCapabilities
  fetchBotInfo(): Promise<ChannelInfo>
  fetchChatInfo(rawChatId: string): Promise<ChatInfo>
  fetchChatDetail(rawChatId: string): Promise<string>
  fetchChatList(): Promise<ChatListItem[]>
  fetchChatMembers(rawChatId: string): Promise<Record<string, string>>
  formatMessages(messages: Message[], userCache: UserCache, chatId?: string): Promise<string>
  getUserCache(): UserCache
  /** 注入群名称映射（key 为带前缀的 chatId） */
  setChatNames(map: Map<string, string>): void
}

export class Channel {
  private impls = new Map<string, ChannelImpl>()

  addImpl(impl: ChannelImpl): void {
    this.impls.set(impl.prefix, impl)
  }

  getImpl(prefix: string): ChannelImpl | undefined {
    return this.impls.get(prefix)
  }

  getAllImpls(): ChannelImpl[] {
    return [...this.impls.values()]
  }

  /** 解析 "lark:oc_xxx" → { prefix: "lark", rawId: "oc_xxx" } */
  static parseChatId(chatId: string): { prefix: string; rawId: string } {
    const idx = chatId.indexOf(":")
    if (idx === -1) return { prefix: "lark", rawId: chatId }
    return { prefix: chatId.slice(0, idx), rawId: chatId.slice(idx + 1) }
  }

  /** 构建前缀 chatId */
  static buildChatId(prefix: string, rawId: string): string {
    return `${prefix}:${rawId}`
  }

  // ---- 路由方法 ----

  async send(chatId: string, content: SendContent): Promise<string> {
    const { prefix, rawId } = Channel.parseChatId(chatId)
    const impl = this.impls.get(prefix)
    if (!impl) throw new Error(`未知 channel: ${prefix}`)
    return impl.send(rawId, content)
  }

  async download(chatId: string, messageId: string, fileId: string, type: "image" | "file", fileName?: string): Promise<string> {
    const { prefix, rawId } = Channel.parseChatId(chatId)
    const impl = this.impls.get(prefix)
    if (!impl) throw new Error(`未知 channel: ${prefix}`)
    return impl.download(messageId, fileId, type, fileName)
  }

  async fetchBotInfo(chatId: string): Promise<ChannelInfo> {
    const { prefix } = Channel.parseChatId(chatId)
    const impl = this.impls.get(prefix)
    if (!impl) throw new Error(`未知 channel: ${prefix}`)
    return impl.fetchBotInfo()
  }

  async fetchChatInfo(chatId: string): Promise<ChatInfo> {
    const { prefix, rawId } = Channel.parseChatId(chatId)
    const impl = this.impls.get(prefix)
    if (!impl) throw new Error(`未知 channel: ${prefix}`)
    return impl.fetchChatInfo(rawId)
  }

  async fetchChatDetail(chatId: string): Promise<string> {
    const { prefix, rawId } = Channel.parseChatId(chatId)
    const impl = this.impls.get(prefix)
    if (!impl) throw new Error(`未知 channel: ${prefix}`)
    return impl.fetchChatDetail(rawId)
  }

  async fetchChatMembers(chatId: string): Promise<Record<string, string>> {
    const { prefix, rawId } = Channel.parseChatId(chatId)
    const impl = this.impls.get(prefix)
    if (!impl) throw new Error(`未知 channel: ${prefix}`)
    return impl.fetchChatMembers(rawId)
  }

  async formatMessages(messages: Message[], chatId: string): Promise<string> {
    const { prefix, rawId } = Channel.parseChatId(chatId)
    const impl = this.impls.get(prefix)
    if (!impl) throw new Error(`未知 channel: ${prefix}`)
    return impl.formatMessages(messages, impl.getUserCache(), chatId)
  }

  /** 按前缀分发群名称映射 */
  setChatNames(map: Map<string, string>): void {
    for (const [prefix, impl] of this.impls) {
      const filtered = new Map<string, string>()
      for (const [chatId, name] of map) {
        if (chatId.startsWith(`${prefix}:`)) filtered.set(chatId, name)
      }
      impl.setChatNames(filtered)
    }
  }

  /** 合并所有 impl 的 chat list */
  async fetchChatList(): Promise<ChatListItem[]> {
    const results: ChatListItem[] = []
    for (const impl of this.impls.values()) {
      const items = await impl.fetchChatList()
      results.push(...items)
    }
    return results
  }

  /** 合并所有 impl 的 capabilities */
  capabilities(): ChannelCapabilities {
    const descs: string[] = []
    const prompts: string[] = []
    for (const impl of this.impls.values()) {
      const cap = impl.capabilities()
      descs.push(cap.description)
      prompts.push(cap.systemPrompt)
    }
    return {
      description: descs.join("\n"),
      systemPrompt: prompts.join("\n"),
    }
  }

  // ---- 合并监听 + 防抖 + cron ----

  async *feed(cronManager: CronManager, webhookManager: WebhookManager, delay = 3000): AsyncGenerator<FeedEvent[]> {
    let staged: FeedEvent[] = []
    let wake: (() => void) | null = null

    // 为每个 impl 启动后台监听
    for (const impl of this.impls.values()) {
      ;(async () => {
        for await (const message of impl.listen()) {
          staged.push({ type: "message", message })
          const w = wake as (() => void) | null; wake = null; w?.()
        }
      })()
    }

    // 监听 cron 触发
    cronManager.onFire((chatId, prompt) => {
      staged.push({ type: "cron", chatId, prompt })
      const w = wake as (() => void) | null; wake = null; w?.()
    })

    // 监听 webhook 触发
    webhookManager.onFire((chatId, prompt) => {
      staged.push({ type: "cron", chatId, prompt })
      const w = wake as (() => void) | null; wake = null; w?.()
    })

    while (true) {
      if (staged.length === 0) {
        await new Promise<void>(r => { wake = r })
      }

      // 防抖
      while (true) {
        const len = staged.length
        await new Promise<void>(r => setTimeout(r, delay))
        if (staged.length === len) break
      }

      const events = staged
      staged = []
      yield events
    }
  }
}
