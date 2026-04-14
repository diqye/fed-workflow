import { run } from "./agent";
import { debounceMessages, fetchChatList, fetchChatRaw, createUserCache } from "./lark";
import { initLog, Log } from "./log";
import { loadConfig, saveConfig, updateProject, type Config, type ProjectConfig } from "./config";
import { parseArgs } from "util"
import { existsSync } from "fs"
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
        console.log(list.data)
        return
    }

    const configPath = parsed.values.config ?? "fed-workflow.yaml"

    if(parsed.values.init) {
        if(existsSync(configPath)) {
            console.error(`配置文件已存在: ${configPath}`)
            process.exit(1)
        }
        const template: Config = {
            log: "/var/log/fed-workflow.log",
            projects: [
                {
                    chatId: "oc_xxx",
                    cwd: "/path/to/project",
                    favorite: ["ou_xxx"],
                },
            ],
        }
        await saveConfig(configPath, template)
        console.log(`已创建配置文件: ${configPath}`)
        return
    }

    const config = await loadConfig(configPath)

    // 日志
    if(config.log) {
        await initLog(config.log)
    }

    // 自动填充缺失的 groupName / description
    for(const project of config.projects) {
        if(!project.groupName || !project.description) {
            const chatRaw = await fetchChatRaw(project.chatId)
            const patch: Record<string, string> = {}
            if(!project.groupName) patch.groupName = chatRaw.name
            if(!project.description) patch.description = chatRaw.description
            await updateProject(configPath, config, project.chatId, patch)
        }
        console.log(`项目: ${project.groupName ?? project.chatId}, cwd: ${project.cwd}, conversationId: ${project.conversationId ?? "新建"}`)
    }

    const userCache = createUserCache()
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
        const log = Log.scope(chatId)

        log.info("startRun, msgs:", String(runMsgs.length), "conversationId:", project.conversationId ?? "null")

        try {
            const sessionId = await run(runMsgs, {
                chatId,
                chatDetail,
                cwd: project.cwd,
                favorite: project.favorite ?? [],
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
