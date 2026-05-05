import { existsSync, readFileSync } from "fs"
import YAML from "yaml"
import { Log } from "./log"
import { WEBHOOK_FILE, type Webhook, type WebhookGroup } from "./const"

export type { Webhook }

type OnFire = (chatId: string, prompt: string) => void

function loadGroups(): WebhookGroup[] {
  if (!existsSync(WEBHOOK_FILE)) return []
  const text = readFileSync(WEBHOOK_FILE, "utf-8")
  const groups: WebhookGroup[] = YAML.parse(text) ?? []
  // 兼容旧数据：无前缀自动加 "lark:"
  let dirty = false
  for (const g of groups) {
    if (!g.chatId.includes(":")) {
      g.chatId = `lark:${g.chatId}`
      dirty = true
    }
  }
  if (dirty) saveGroups(groups)
  return groups
}

function saveGroups(groups: WebhookGroup[]) {
  void Bun.write(WEBHOOK_FILE, YAML.stringify(groups))
}

export class WebhookManager {
  private baseUrl: string
  private onFireCallback: OnFire | null = null

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  onFire(callback: OnFire) {
    this.onFireCallback = callback
  }

  /** 启动时清理过期 webhook */
  cleanup() {
    const groups = loadGroups()
    const now = Date.now()
    let changed = false
    for (const g of groups) {
      const before = g.webhooks.length
      g.webhooks = g.webhooks.filter(w => !(w.expiresIn > 0 && now > w.createdAt + w.expiresIn * 1000))
      if (g.webhooks.length < before) {
        changed = true
        Log.info(`Webhook 清理: ${g.chatId} 删除了 ${before - g.webhooks.length} 个过期 webhook`)
      }
    }
    // 清理空 group
    const before = groups.length
    const remaining = groups.filter(g => g.webhooks.length > 0)
    if (remaining.length < before) changed = true
    if (changed) saveGroups(remaining)
  }

  url(id: string): string {
    return `${this.baseUrl}/agent/hook/${id}`
  }

  create(chatId: string, prompt: string, opts?: { expiresIn?: number; method?: string; id?: string }): Webhook {
    const groups = loadGroups()
    let group = groups.find(g => g.chatId === chatId)
    if (!group) {
      group = { chatId, webhooks: [] }
      groups.push(group)
    }

    // 有 id → 更新
    if (opts?.id) {
      const existing = group.webhooks.find(w => w.id === opts.id)
      if (existing) {
        existing.method = opts.method ?? existing.method ?? "POST"
        existing.prompt = prompt
        if (opts.expiresIn !== undefined) existing.expiresIn = opts.expiresIn
        saveGroups(groups)
        Log.info(`Webhook 已更新: ${chatId}:${existing.id} method=${existing.method} expiresIn=${existing.expiresIn}`)
        return existing
      }
    }

    // 无 id 或 id 不存在 → 创建
    const id = opts?.id ?? `wh_${Date.now().toString(36)}`
    const webhook: Webhook = {
      id,
      chatId,
      method: opts?.method ?? "POST",
      prompt,
      expiresIn: opts?.expiresIn ?? 0,
      createdAt: Date.now(),
    }
    group.webhooks.push(webhook)
    saveGroups(groups)

    Log.info(`Webhook 已创建: ${chatId}:${id} method=${webhook.method} expiresIn=${webhook.expiresIn}`)
    return webhook
  }

  delete(chatId: string, id: string): boolean {
    const groups = loadGroups()
    const group = groups.find(g => g.chatId === chatId)
    if (!group) return false

    const idx = group.webhooks.findIndex(w => w.id === id)
    if (idx === -1) return false

    group.webhooks.splice(idx, 1)
    if (group.webhooks.length === 0) {
      const gIdx = groups.indexOf(group)
      groups.splice(gIdx, 1)
    }
    saveGroups(groups)

    Log.info(`Webhook 已删除: ${chatId}:${id}`)
    return true
  }

  list(chatId: string): Webhook[] {
    this.cleanup()
    const groups = loadGroups()
    const group = groups.find(g => g.chatId === chatId)
    return group?.webhooks ?? []
  }

  /** 处理 HTTP 请求，返回 { status, body } */
  handleRequest(id: string, method: string, url: string, body: string): { status: number; body: string } {
    const groups = loadGroups()
    let found: Webhook | undefined
    let foundGroup: WebhookGroup | undefined

    for (const g of groups) {
      const wh = g.webhooks.find(w => w.id === id)
      if (wh) {
        found = wh
        foundGroup = g
        break
      }
    }

    if (!found) return { status: 404, body: "webhook not found" }

    if (found.method !== method) return { status: 405, body: `method not allowed, expected ${found.method}` }

    // 检查过期
    if (found.expiresIn > 0 && Date.now() > found.createdAt + found.expiresIn * 1000) {
      // 过期删除
      this.delete(found.chatId, found.id)
      return { status: 410, body: "webhook expired" }
    }

    // 替换占位符
    const prompt = found.prompt
      .replaceAll("{{body}}", body)
      .replaceAll("{{url}}", url)

    // 一次性 webhook：触发后删除
    if (found.expiresIn === 0) {
      this.delete(found.chatId, found.id)
    }

    Log.info(`Webhook 触发: ${found.chatId}:${found.id}`)
    this.onFireCallback?.(found.chatId, prompt)

    return { status: 200, body: "ok" }
  }
}
