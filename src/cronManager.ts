import { CronJob } from "cron"
import { existsSync, readFileSync } from "fs"
import YAML from "yaml"
import { Log } from "./log"
import { CRON_FILE, type CronGroup, type CronTask } from "./const"

type OnFire = (chatId: string, prompt: string) => void

function loadGroups(): CronGroup[] {
  if (!existsSync(CRON_FILE)) return []
  const text = readFileSync(CRON_FILE, "utf-8")
  return YAML.parse(text) ?? []
}

function saveGroups(groups: CronGroup[]) {
  void Bun.write(CRON_FILE, YAML.stringify(groups))
}

export class CronManager {
  private scheduled = new Map<string, CronJob>()
  private onFireCallback: OnFire | null = null

  /** 注册 cron 触发回调 */
  onFire(callback: OnFire) {
    this.onFireCallback = callback
  }

  /** 启动时加载所有任务并注册调度 */
  loadAll() {
    const groups = loadGroups()
    for (const group of groups) {
      for (const task of group.tasks) {
        this.register(group.chatId, task)
      }
    }
    Log.info(`CronManager: 已加载 ${this.scheduled.size} 个定时任务`)
  }

  private register(chatId: string, task: CronTask) {
    const key = `${chatId}:${task.id}`
    if (this.scheduled.has(key)) return

    try {
      const job = new CronJob(task.expression, () => {
        Log.info(`Cron 触发: ${key} "${task.prompt}"`)
        this.onFireCallback?.(chatId, task.prompt)
      }, null, true)
      this.scheduled.set(key, job)
    } catch (e) {
      Log.error(`Cron 注册失败: ${key}, expression: ${task.expression}, ${String(e)}`)
    }
  }

  private unregister(chatId: string, taskId: string) {
    const key = `${chatId}:${taskId}`
    const job = this.scheduled.get(key)
    if (job) {
      job.stop()
      this.scheduled.delete(key)
    }
  }

  create(chatId: string, expression: string, prompt: string): CronTask {
    const groups = loadGroups()
    let group = groups.find(g => g.chatId === chatId)
    if (!group) {
      group = { chatId, tasks: [] }
      groups.push(group)
    }

    const id = `c${Date.now().toString(36)}`
    const task: CronTask = { id, expression, prompt }
    group.tasks.push(task)
    saveGroups(groups)

    this.register(chatId, task)
    Log.info(`Cron 已创建: ${chatId}:${id} "${expression}" "${prompt}"`)
    return task
  }

  delete(chatId: string, taskId: string): boolean {
    const groups = loadGroups()
    const group = groups.find(g => g.chatId === chatId)
    if (!group) return false

    const idx = group.tasks.findIndex(t => t.id === taskId)
    if (idx === -1) return false

    group.tasks.splice(idx, 1)
    if (group.tasks.length === 0) {
      const gIdx = groups.indexOf(group)
      groups.splice(gIdx, 1)
    }
    saveGroups(groups)

    this.unregister(chatId, taskId)
    Log.info(`Cron 已删除: ${chatId}:${taskId}`)
    return true
  }

  list(chatId: string): CronTask[] {
    const groups = loadGroups()
    const group = groups.find(g => g.chatId === chatId)
    return group?.tasks ?? []
  }
}
