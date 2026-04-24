import { join } from "path"
import { mkdirSync } from "fs"
import { FED_LOG_DIR } from "./const"
import { logLevel } from "./env"

let logPath = ""

export async function initLog() {
    mkdirSync(FED_LOG_DIR, { recursive: true })
    const ts = new Date().toISOString().slice(0, 10)
    logPath = join(FED_LOG_DIR, `log-${ts}.txt`)
    await Bun.write(logPath, "")
}

function createLogStream() {
    let log = null as null | Bun.FileSink
    return () => {
        if(log) return log
        if(!logPath) {
            console.error("日志未初始化，请先调用 initLog()")
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

function currentLevel() {
  return LEVELS[logLevel()] ?? 0
}

type LogFn = (...texts: string[]) => void

function makeLog(prefix: string, level: string): LogFn {
    const lv = LEVELS[level]!
    return (...texts: string[]) => {
        if(currentLevel() > lv) return
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
