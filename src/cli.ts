import { run } from "./agent";
import { Channel } from "./message/channel";
import type { Message, FeedEvent } from "./message/types";
import { LarkImpl } from "./lark";
import { initLog, Log } from "./log";
import { loadConfig, saveConfig, updateProject, addProject } from "./config";
import { CronManager } from "./cronManager";
import { WebhookManager } from "./webhookManager";
import { parseArgs } from "util"
import { existsSync, mkdirSync, copyFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { Glob } from "bun"
import { PROFILES_DIR, FED_DIR, FED_CONFIG_PATH, FED_PROJECTS_DIR, MAX_MESSAGES_PER_RUN, type Config, type ProjectConfig } from "./const"

function buildChatDetail(project: ProjectConfig): string {
  const lines = [
    `**${project.groupName ?? project.chatId}**`,
    `- **描述**: ${project.description || "无"}`,
  ]
  return lines.join("\n")
}

type GroupState = {
  pendingMessages: Message[]
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

    // 初始化 Channel
    const channel = new Channel()
    channel.addImpl(new LarkImpl(channel))

    if(parsed.values.list) {
        const list = await channel.fetchChatList()
        console.log(list)
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
            webhook: {
              host: "0.0.0.0",
              port: 7700,
              publicUrl: "https://your-domain.com",
              secret: "secret",
            },
            projects: [
                {
                    chatId: "lark:oc_xxx",
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

    // 预取各 channel 的 bot info
    const botInfoMap = new Map<string, { name: string; id: string }>()
    for (const impl of channel.getAllImpls()) {
      const info = await impl.fetchBotInfo()
      botInfoMap.set(impl.prefix, info)
      Log.info(`bot [${impl.prefix}]:`, info.name, info.id)
    }

    // 验证群可访问性，自动填充 groupName / description
    // 旧配置 chatId 无前缀时，自动加 "lark:" 前缀
    const activeProjects: ProjectConfig[] = []
    for(const project of config.projects) {
        if(project.disabled) continue
        // 兼容旧配置：无前缀自动加 "lark:"
        if(!project.chatId.includes(":")) {
          project.chatId = `lark:${project.chatId}`
          await updateProject(configPath, config, project.chatId, {})
        }
        const { prefix } = Channel.parseChatId(project.chatId)
        const impl = channel.getImpl(prefix)
        if(!impl) {
          console.error(`未知 channel: ${prefix}，跳过群 ${project.chatId}`)
          continue
        }
        try {
            const chatInfo = await channel.fetchChatInfo(project.chatId)
            const patch: Record<string, string> = {}
            if(!project.groupName) patch.groupName = chatInfo.name
            if(!project.description) patch.description = chatInfo.description
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
    channel.setChatNames(chatNames)

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

    // 初始化 WebhookManager
    const webhookHost = config.webhook?.host ?? "0.0.0.0"
    const webhookPort = config.webhook?.port ?? 7700
    const webhookPublicUrl = config.webhook?.publicUrl ?? `http://${webhookHost}:${webhookPort}`
    const webhookSecret = config.webhook?.secret ?? "secret"
    const webhookManager = new WebhookManager(webhookPublicUrl, webhookSecret)
    webhookManager.cleanup()
    Bun.serve({
      hostname: webhookHost,
      port: webhookPort,
      fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.startsWith("/agent/hook/")) {
          return new Response("Not Found", { status: 404 })
        }
        const path = url.pathname.slice("/agent/hook/".length)
        const parts = path.split("/")
        const id = parts[0] ?? ""
        const secret = parts[1] ?? ""
        // secret 后面的路径 + query
        const customPath = parts.slice(2).join("/") + url.search
        const bodyPromise = req.text().catch(() => "")
        return bodyPromise.then(body => {
          const result = webhookManager.handleRequest(id, secret, customPath, body)
          return new Response(result.body, { status: result.status })
        })
      },
    })
    Log.info(`Webhook 服务已启动: ${webhookHost}:${webhookPort}, publicUrl: ${webhookPublicUrl}`)

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
          const formatted = await channel.formatMessages(runMsgs, chatId)
          const backlogHint = isBacklog ? "\n\n注意：这些消息是你上轮运行期间收到的，部分可能已被你之前的回复覆盖，先回顾你已发过的回复再判断是否需要回应。" : ""
          parts.push(`以下是${label} ${runMsgs.length} 条消息：\n\n${formatted}${backlogHint}`)
        }

        const prompt = parts.join("\n\n")
        log.info("startRun, conversationId:", project.conversationId ?? "null")

        const { prefix } = Channel.parseChatId(chatId)
        const botInfo = botInfoMap.get(prefix)

        try {
            const sessionId = await run(prompt, {
                log,
                chatId,
                chatDetail,
                cwd: project.cwd,
                botName: botInfo?.name ?? "bot",
                botOpenId: botInfo?.id ?? "",
                favorite: project.favorite ?? [],
                channel,
                conversationId: project.conversationId ?? null,
                cronManager,
                webhookManager,
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
            if(state.pendingMessages.length > 0 || state.pendingCrons.length > 0) {
                state.isBacklog = true
                startRun(chatId, state).catch(e => log.error(`递归 startRun error: ${String(e)}`))
            }
        }
    }

    // 启动 feed
    cronManager.loadAll()
    const feed = channel.feed(cronManager, webhookManager)

    console.log("开始监听消息")
    for await (const events of feed) {
        for(const event of events) {
          if (event.type === "message") {
            const msg = event.message
            const chatId = msg.chatId

            // 私聊消息：回复不支持
            if(msg.chatType === "private") {
              channel.send(chatId, { type: "text", text: "不支持私聊消息，请在群聊中使用" })
                .catch(e => Log.error(`发送私聊提示失败: ${String(e)}`))
              continue
            }

            // 未配置或已禁用的群：检查是否 /init 命令
            if(!projectMap.has(chatId)) {
              const initMatch = msg.content.match(/^\/init\s+(.+)$/)
              if(!initMatch) continue

              const favorite = initMatch[1]!
              const existing = config.projects.find(p => p.chatId === chatId)
              let groupName = chatId

              if(existing) {
                // 已禁用的群：重新启用
                mkdirSync(existing.cwd, { recursive: true })
                try {
                  const chatInfo = await channel.fetchChatInfo(chatId)
                  existing.groupName = chatInfo.name
                  existing.description = chatInfo.description
                } catch(e) {
                  Log.error(`重新启用获取群信息失败 ${chatId}: ${String(e)}`)
                }
                await updateProject(configPath, config, chatId, { disabled: undefined, favorite: [favorite] })
                existing.disabled = undefined
                existing.favorite = [favorite]
                chatNames.set(chatId, existing.groupName ?? chatId)
                projectMap.set(chatId, existing)
                groupName = existing.groupName ?? chatId
                Log.info(`重新启用群: ${groupName}`)
                console.log(`重新启用群: ${groupName}`)
              } else {
                // 新群
                const cwd = join(FED_PROJECTS_DIR, chatId)
                mkdirSync(cwd, { recursive: true })
                const project: ProjectConfig = { chatId, cwd, favorite: [favorite] }
                try {
                  const chatInfo = await channel.fetchChatInfo(chatId)
                  project.groupName = chatInfo.name
                  project.description = chatInfo.description
                } catch(e) {
                  Log.error(`自动配置获取群信息失败 ${chatId}: ${String(e)}`)
                }
                await addProject(configPath, config, project)
                chatNames.set(chatId, project.groupName ?? chatId)
                projectMap.set(chatId, project)
                groupName = project.groupName ?? chatId
                Log.info(`自动配置新群: ${groupName}, cwd: ${cwd}`)
                console.log(`自动配置新群: ${groupName}, cwd: ${cwd}`)
              }
              channel.send(chatId, { type: "text", text: `配置成功：${groupName}` })
                .catch(e => Log.error(`发送配置成功通知失败: ${String(e)}`))
              continue
            }

            // 已配置的群：检查是否 /stop 或 /reset 命令
            if(msg.content === "/stop") {
              const state = getGroupState(chatId)
              if(state.running && state.abortController) {
                state.abortController.abort()
                Log.info(`收到 /stop 命令，终止群 ${chatId} 的任务`)
                channel.send(chatId, { type: "text", text: "任务已被手动终止" })
                  .catch(e => Log.error(`发送终止通知失败: ${String(e)}`))
              }
              continue
            }
            if(msg.content === "/reset") {
              const project = projectMap.get(chatId)
              if(project?.conversationId) {
                await updateProject(configPath, config, chatId, { conversationId: undefined })
                project.conversationId = undefined
                Log.info(`收到 /reset 命令，已清除群 ${chatId} 的会话`)
                channel.send(chatId, { type: "text", text: "会话已重置，下次对话将开启新 session" })
                  .catch(e => Log.error(`发送重置通知失败: ${String(e)}`))
              }
              continue
            }

            const state = getGroupState(chatId)
            state.pendingMessages.push(msg)
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
