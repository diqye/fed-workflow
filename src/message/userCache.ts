/**
 * 用户缓存——Channel 无关
 */
import { Log } from "../log"
import type { Channel } from "./channel"

export interface UserCache {
  getName(userId: string, chatId?: string): Promise<string>
  put(map: Record<string, string>): void
}

export function createChannelUserCache(
  channel: Channel,
  initial?: Record<string, string>,
  chatNames?: Map<string, string>,
): UserCache {
  const cache = new Map<string, string>(Object.entries(initial ?? {}))
  const fetchedChats = new Set<string>()

  return {
    async getName(userId: string, chatId?: string): Promise<string> {
      const cached = cache.get(userId)
      if (cached) return cached

      if (chatId && !fetchedChats.has(chatId)) {
        fetchedChats.add(chatId)
        try {
          const members = await channel.fetchChatMembers(chatId)
          for (const [k, v] of Object.entries(members)) cache.set(k, v)
          const chatName = chatNames?.get(chatId) ?? chatId
          Log.info(`群成员缓存已填充: ${chatName} (${Object.keys(members).length}人)`)
        } catch {}
        const name = cache.get(userId)
        if (name) return name
      }

      return userId
    },
    put(map: Record<string, string>) {
      for (const [k, v] of Object.entries(map)) cache.set(k, v)
    },
  }
}
