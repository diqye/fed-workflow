import { LOG_LEVEL } from "./const"

function createLogStream() {
    let log = null as null | Bun.FileSink
    return () => {
        if(log) return log
        log = Bun.file("log-zylon.txt").writer()

        return log
    }
}

const logF = createLogStream()

function log(...texts:string[]) {
    logF().write(texts.join(" - ") + "\n")
    logF().flush()
}

export const Log = {
    debug:(...texts:string[]) => {
        if(LOG_LEVEL != "debug") return
        log("[debug]",...texts)
    },
    info:(...texts:string[]) => {
        if(LOG_LEVEL != "info") return Log.debug(...texts)
        log("[info]",...texts)
    },
    error:(...texts:string[]) => {
        if(LOG_LEVEL != "error") return Log.info(...texts)
        log("[error]",...texts)
    },
    
}