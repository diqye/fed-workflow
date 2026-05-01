import { run } from "./agent";
import { createFeed, fetchChatList, fetchChatRaw, fetchBotInfo, createUserCache, formatMessages, sendMessage } from "./lark";
import { initLog, Log } from "./log";
import { loadConfig, saveConfig, updateProject, addProject, type Config, type ProjectConfig } from "./config";
import { CronManager } from "./cronManager";
import { parseArgs } from "util"
import { existsSync, mkdirSync, copyFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { Glob } from "bun"
import { PROFILES_DIR, FED_DIR, FED_CONFIG_PATH, FED_PROJECTS_DIR } from "./const"
import type { LarkMessage } from "./const"

const MAX_MESSAGES_PER_RUN = 50

/** 从飞书消息中提取纯文本内容 */
function parseMessageText(msg: LarkMessage): string | null {
  try {
    const obj = JSON.parse(msg.event.message.content)
    if (obj.text && typeof obj.text === "string") return obj.text
  } catch {}
  return null
}

function buildChatDetail(project: ProjectConfig): string {
  const lines = [
    `**${project.groupName ?? project.chatId}**`,
    `- **描述**: ${project.description || "无"}`,
  ]
  return lines.join("\n")
}

type GroupState = {
  pendingMessages: LarkMessage[]
  pendingCrons: { prompt: string }[]
  running: boolean
  isBacklog: boolean
  abortController: AbortController | null
}

export async function main() {
    const version = "0.1"
    const parsed = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            version: { type: "boolean" },
            help: { type: "boolean" },
            list: { type: "boolean" },
            init: { type: "boolean" },
        }
    })

    if(parsed.values.version) {
        console.log("Version=",version)
        return
    }
    if(parsed.values.help) {
        console.log([
            "--version                    print version",
            "--help                       print this messages",
            "--list                       view chat list",
            "--init                       create config template",
        ].join("\n"),version)
        return
    }
    if(parsed.values.list) {
        const list = await fetchChatList()
        console.log(list.data.items.map((a:any)=>{
            return {
                name: a.name,
                chat_id: a.chat_id
            }
        }))
        return
    }

    const configPath = FED_CONFIG_PATH

    if(parsed.values.init) {
        if(existsSync(configPath)) {
            console.error(`配置文件已存在: ${configPath}`)
            process.exit(1)
        }
        mkdirSync(FED_DIR, { recursive: true })
        const template: Config = {
            env: {
              LOG_LEVEL: "info",
              zhipu_token: "xxxx",
            },
            projects: [
                {
                    chatId: "oc_xxx",
                    cwd: "/path/to/project",
                    favorite: ["vallino 称呼为哥"],
                },
            ],
        }
        await saveConfig(configPath, template)
        console.log(`已创建配置文件: ${configPath}`)
        return
    }

    const config = await loadConfig(configPath)

    // 注入配置中的环境变量（覆盖系统环境变量）
    if (config.env) {
      Object.assign(Bun.env, config.env)
    }

    // 初始化日志（必须在其他 Log 调用之前）
    await initLog()

    // 初始化目录
    mkdirSync(PROFILES_DIR, { recursive: true })
    Log.info("profiles dir:", PROFILES_DIR)

    // 部署 skills 到全局目录
    const globalSkillsDir = join(homedir(), ".claude", "skills")
    const projectSkillsDir = join(import.meta.dir, "..", "skills")
    if(existsSync(projectSkillsDir)) {
      for(const dir of new Glob("*/SKILL.md").scanSync({ cwd: projectSkillsDir })) {
        const skillName = dir.split("/")[0]!
        const targetDir = join(globalSkillsDir, skillName)
        mkdirSync(targetDir, { recursive: true })
        copyFileSync(join(projectSkillsDir, dir), join(targetDir, "SKILL.md"))
        Log.info(`skill deployed: ${skillName}`)
      }
    }

    // 获取机器人自身信息
    const botInfo = await fetchBotInfo()
    Log.info("bot:", botInfo.name, botInfo.open_id)

    // 验证群可访问性，自动填充 groupName / description
    const activeProjects: ProjectConfig[] = []
    for(const project of config.projects) {
        if(project.disabled) continue
        try {
            const chatRaw = await fetchChatRaw(project.chatId)
            const patch: Record<string, string> = {}
            if(!project.groupName) patch.groupName = chatRaw.name
            if(!project.description) patch.description = chatRaw.description
            if(Object.keys(patch).length > 0) await updateProject(configPath, config, project.chatId, patch)
            mkdirSync(project.cwd, { recursive: true })
            activeProjects.push(project)
            console.log(`项目: ${project.groupName ?? project.chatId}, cwd: ${project.cwd}, conversationId: ${project.conversationId ?? "新建"}`)
        } catch(e) {
            console.error(`群 ${project.groupName ?? project.chatId}(${project.chatId}) 不可访问，已标记 disabled: ${e}`)
            Log.error(`群 ${project.chatId} 不可访问，已标记 disabled: ${String(e)}`)
            await updateProject(configPath, config, project.chatId, { disabled: true })
        }
    }

    const chatNames = new Map(activeProjects.map(p => [p.chatId, p.groupName ?? p.chatId]))
    const userCache = createUserCache({ [botInfo.open_id]: botInfo.name }, chatNames)

    const projectMap = new Map(activeProjects.map(p => [p.chatId, p]))
    const groupStates = new Map<string, GroupState>()

    function getGroupState(chatId: string): GroupState {
        let state = groupStates.get(chatId)
        if(!state) {
            state = { pendingMessages: [], pendingCrons: [], running: false, isBacklog: false, abortController: null }
            groupStates.set(chatId, state)
        }
        return state
    }

    // 初始化 CronManager
    const cronManager = new CronManager()

    async function startRun(chatId: string, state: GroupState) {
        if(state.running) return
        if(state.pendingMessages.length === 0 && state.pendingCrons.length === 0) return

        const project = projectMap.get(chatId)
        if(!project) return

        state.running = true
        state.abortController = new AbortController()
        const chatDetail = buildChatDetail(project)
        const log = Log.scope(`${project.groupName ?? "unknown"}(${chatId})`)

        // 构建 prompt
        const parts: string[] = []
        const isBacklog = state.isBacklog
        state.isBacklog = false

        if (state.pendingCrons.length > 0) {
          for (const c of state.pendingCrons) {
            parts.push(`[定时任务触发] ${c.prompt}`)
          }
          state.pendingCrons = []
        }
        if (state.pendingMessages.length > 0) {
          const allMsgs = state.pendingMessages
          state.pendingMessages = []
          const runMsgs = allMsgs.length > MAX_MESSAGES_PER_RUN
              ? allMsgs.slice(-MAX_MESSAGES_PER_RUN)
              : allMsgs
          const label = isBacklog ? "上次运行期间积累的" : "新收到的"
          const formatted = await formatMessages(runMsgs, userCache, chatId)
          const backlogHint = isBacklog ? "\n\n注意：这些消息是你上轮运行期间收到的，部分可能已被你之前的回复覆盖，先回顾你已发过的回复再判断是否需要回应。" : ""
          parts.push(`以下是${label} ${runMsgs.length} 条消息：\n\n${formatted}${backlogHint}`)
        }

        const prompt = parts.join("\n\n")
        log.info("startRun, conversationId:", project.conversationId ?? "null")

        try {
            const sessionId = await run(prompt, {
                log,
                chatId,
                chatDetail,
                cwd: project.cwd,
                botName: botInfo.name,
                botOpenId: botInfo.open_id,
                favorite: project.favorite ?? [],
                profilesDir: PROFILES_DIR,
                userCache,
                conversationId: project.conversationId ?? null,
                cronManager,
                abortController: state.abortController,
            })

            if(sessionId && sessionId !== project.conversationId) {
                await updateProject(configPath, config, chatId, { conversationId: sessionId })
            }
        } catch(e) {
            log.error("startRun error:", String(e))
        } finally {
            state.running = false
            state.abortController = null
            log.info("run completed, pending msgs:", String(state.pendingMessages.length), "crons:", String(state.pendingCrons.length))
            // run 完成后如果又有新事件积累，继续执行（标记为积压）
            if(state.pendingMessages.length > 0 || state.pendingCrons.length > 0) {
                state.isBacklog = true
                startRun(chatId, state).catch(e => log.error(`递归 startRun error: ${String(e)}`))
            }
        }
    }

    // 启动 feed
    cronManager.loadAll()
    const feed = createFeed(cronManager)

    console.log("开始监听消息")
    for await (const events of feed) {
        for(const event of events) {
          if (event.type === "message") {
            const chatId = event.message.event.message.chat_id

            // 未配置或已禁用的群：检查是否 /init 命令
            if(!projectMap.has(chatId)) {
              const text = parseMessageText(event.message)
              const initMatch = text?.match(/^\/init\s+(.+)$/)
              if(!initMatch) continue

              const favorite = initMatch[1]!
              const existing = config.projects.find(p => p.chatId === chatId)

              if(existing) {
                // 已禁用的群：重新启用
                mkdirSync(existing.cwd, { recursive: true })
                try {
                  const chatRaw = await fetchChatRaw(chatId)
                  existing.groupName = chatRaw.name
                  existing.description = chatRaw.description
                } catch(e) {
                  Log.error(`重新启用获取群信息失败 ${chatId}: ${String(e)}`)
                }
                await updateProject(configPath, config, chatId, { disabled: undefined, favorite: [favorite] })
                existing.disabled = undefined
                existing.favorite = [favorite]
                chatNames.set(chatId, existing.groupName ?? chatId)
                projectMap.set(chatId, existing)
                Log.info(`重新启用群: ${existing.groupName ?? chatId}`)
                console.log(`重新启用群: ${existing.groupName ?? chatId}`)
              } else {
                // 新群
                const cwd = join(FED_PROJECTS_DIR, chatId)
                mkdirSync(cwd, { recursive: true })
                const project: ProjectConfig = { chatId, cwd, favorite: [favorite] }
                try {
                  const chatRaw = await fetchChatRaw(chatId)
                  project.groupName = chatRaw.name
                  project.description = chatRaw.description
                } catch(e) {
                  Log.error(`自动配置获取群信息失败 ${chatId}: ${String(e)}`)
                }
                await addProject(configPath, config, project)
                projectMap.set(chatId, project)
                Log.info(`自动配置新群: ${project.groupName ?? chatId}, cwd: ${cwd}`)
                console.log(`自动配置新群: ${project.groupName ?? chatId}, cwd: ${cwd}`)
              }
              continue
            }

            // 已配置的群：检查是否 /stop 命令
            const text = parseMessageText(event.message)
            if(text === "/stop") {
              const state = getGroupState(chatId)
              if(state.running && state.abortController) {
                state.abortController.abort()
                Log.info(`收到 /stop 命令，终止群 ${chatId} 的任务`)
                sendMessage(chatId, "任务已被手动终止").catch(e => Log.error(`发送终止通知失败: ${String(e)}`))
              }
              continue
            }

            const state = getGroupState(chatId)
            state.pendingMessages.push(event.message)
          } else {
            // cron event
            const state = getGroupState(event.chatId)
            state.pendingCrons.push({ prompt: event.prompt })
          }
        }

        // 对所有有待处理事件的群，如果没有在运行则启动 run
        for(const [chatId, state] of groupStates) {
            if((state.pendingMessages.length > 0 || state.pendingCrons.length > 0) && !state.running) {
                startRun(chatId, state).catch(e => Log.error(`startRun error ${chatId}: ${String(e)}`))
            }
        }
    }
}
