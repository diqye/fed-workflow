import { isAbsolute, join } from "path"
import { writeFile } from "fs/promises"
import { LOG_LEVEL } from "./const"

let logPath = ""

export async function initLog(path: string) {
    logPath = isAbsolute(path) ? path : join(process.cwd(), path)
    // 启动时清空日志文件
    await writeFile(logPath, "")
}

function createLogStream() {
    let log = null as null | Bun.FileSink
    return () => {
        if(log) return log
        if(!logPath) {
            console.error("请通过配置文件 log 字段指定日志文件路径")
            process.exit(1)
        }
        log = Bun.file(logPath).writer()

        return log
    }
}

const logF = createLogStream()

function log(...texts:string[]) {
    logF().write(texts.join(" - ") + "\n")
    logF().flush()
}

const LEVELS: Record<string, number> = { debug: 0, info: 1, error: 2 }
const currentLevel = LEVELS[LOG_LEVEL] ?? 0

type LogFn = (...texts: string[]) => void

function makeLog(prefix: string, level: string): LogFn {
    const lv = LEVELS[level]!
    return (...texts: string[]) => {
        if(currentLevel > lv) return
        log(`[${level}]`, prefix, ...texts)
    }
}

function createScopedLog(scope: string) {
    return {
        debug: makeLog(scope, "debug"),
        info: makeLog(scope, "info"),
        error: makeLog(scope, "error"),
        scope: (sub: string) => createScopedLog(`${scope} - ${sub}`),
    }
}

export const Log = createScopedLog("main")
