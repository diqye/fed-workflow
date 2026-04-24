import { run } from "./agent";
import { debounceMessages, fetchChatList, fetchChatRaw, fetchChatMembers, fetchBotInfo, createUserCache } from "./lark";
import { initLog, Log } from "./log";
import { loadConfig, saveConfig, updateProject, type Config, type ProjectConfig } from "./config";
import { parseArgs } from "util"
import { existsSync, mkdirSync } from "fs"
import { PROFILES_DIR, FED_DIR, FED_CONFIG_PATH } from "./const"
import type { LarkMessage } from "./const"

const MAX_MESSAGES_PER_RUN = 50

function buildChatDetail(project: ProjectConfig): string {
  const lines = [
    `**${project.groupName ?? project.chatId}**`,
    `- **描述**: ${project.description || "无"}`,
  ]
  return lines.join("\n")
}

type GroupState = {
  pending: LarkMessage[]
  running: boolean
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
            config: { type: "string" },
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
            "--config           [path]    config file path (yaml)"
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

    const configPath = parsed.values.config ?? FED_CONFIG_PATH

    if(parsed.values.init) {
        if(existsSync(configPath)) {
            console.error(`配置文件已存在: ${configPath}`)
            process.exit(1)
        }
        mkdirSync(FED_DIR, { recursive: true })
        const template: Config = {
            projects: [
                {
                    chatId: "oc_xxx",
                    cwd: "/path/to/project",
                    favorite: ["秦振龙 称呼为哥"],
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

    // 获取机器人自身信息
    const botInfo = await fetchBotInfo()
    Log.info("bot:", botInfo.name, botInfo.open_id)

    // 自动填充缺失的 groupName / description
    for(const project of config.projects) {
        try {
            if(!project.groupName || !project.description) {
                const chatRaw = await fetchChatRaw(project.chatId)
                const patch: Record<string, string> = {}
                if(!project.groupName) patch.groupName = chatRaw.name
                if(!project.description) patch.description = chatRaw.description
                await updateProject(configPath, config, project.chatId, patch)
            }
        } catch(e) {
            const msg = `群 ${project.chatId} 不存在或无权限访问，请检查配置`
            console.error(msg)
            Log.error(msg)
        }
        console.log(`项目: ${project.groupName ?? project.chatId}, cwd: ${project.cwd}, conversationId: ${project.conversationId ?? "新建"}`)
    }

    // 预填充用户缓存（通过群成员 API 获取名字）
    const initialUsers: Record<string, string> = {}
    for(const project of config.projects) {
        try {
            const members = await fetchChatMembers(project.chatId)
            Object.assign(initialUsers, members)
        } catch(e) {
            const msg = `获取群成员失败 ${project.chatId}，群可能不存在或无权限`
            console.error(msg)
            Log.error(msg)
        }
    }
    const userCache = createUserCache({ ...initialUsers, [botInfo.open_id]: botInfo.name })
    const projectMap = new Map(config.projects.map(p => [p.chatId, p]))
    const groupStates = new Map<string, GroupState>()

    function getGroupState(chatId: string): GroupState {
        let state = groupStates.get(chatId)
        if(!state) {
            state = { pending: [], running: false }
            groupStates.set(chatId, state)
        }
        return state
    }

    async function startRun(chatId: string, state: GroupState) {
        if(state.running || state.pending.length === 0) return

        const project = projectMap.get(chatId)
        if(!project) return

        // 取所有待处理消息，超过上限则只取最新的 MAX_MESSAGES_PER_RUN 条
        const allMsgs = state.pending
        state.pending = []
        const runMsgs = allMsgs.length > MAX_MESSAGES_PER_RUN
            ? allMsgs.slice(-MAX_MESSAGES_PER_RUN)
            : allMsgs

        state.running = true
        const chatDetail = buildChatDetail(project)
        const log = Log.scope(`${project.groupName ?? "unknown"}(${chatId})`)

        log.info("startRun, msgs:", String(runMsgs.length), "conversationId:", project.conversationId ?? "null")

        try {
            const sessionId = await run(runMsgs, {
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
            })

            if(sessionId && sessionId !== project.conversationId) {
                await updateProject(configPath, config, chatId, { conversationId: sessionId })
            }
        } catch(e) {
            log.error("startRun error:", String(e))
        } finally {
            state.running = false
            log.info("run completed, pending:", String(state.pending.length))
            // run 完成后如果又有新消息积累，继续执行
            if(state.pending.length > 0) {
                startRun(chatId, state)
            }
        }
    }

    console.log("开始监听消息")
    for await (const messages of debounceMessages()) {
        for(const msg of messages) {
            const chatId = msg.event.message.chat_id
            if(!projectMap.has(chatId)) continue

            const state = getGroupState(chatId)
            state.pending.push(msg)
        }

        // 对所有有消息的群，如果没有在运行则启动 run
        for(const [chatId] of groupStates) {
            const state = getGroupState(chatId)
            if(state.pending.length > 0 && !state.running) {
                startRun(chatId, state)
            }
        }
    }
}
