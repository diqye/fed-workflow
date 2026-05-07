#!/usr/bin/env bun
import type { BunFile } from "bun";
import { FED_LOG_DIR } from "../const";
import {watch} from "fs"

const glob = new Bun.Glob("*.txt")
let live_file_info = null as [BunFile,string] | null
for await (const file_path of glob.scan({cwd:FED_LOG_DIR,absolute:true})) {
    const file = Bun.file(file_path)
    if(live_file_info == null) {
        live_file_info = [file,file_path]
        continue
    }
    const stat = await file.stat()
    const live_stat = await live_file_info[0].stat()
    live_file_info = stat.birthtime.getTime() > live_stat.birthtime.getTime() ? [file,file_path] : live_file_info
}

if(live_file_info == null) {
    console.log("Unfind log file")
    process.exit(0)
}
const [live_file,live_path] = live_file_info


let last_size = live_file.size
const tail_size = Math.max(last_size - 1000,0)

const writer = Bun.stdout.writer()

await writer.write(await live_file.slice(tail_size,last_size).bytes())

await writer.write("\n======================\n")
await writer.write("log path: " + live_path + "\n")
await writer.write("======================\n")
await writer.flush()
watch(live_path,async (e)=>{
    if(e != "change") return
    const file = Bun.file(live_path)
    const size = file.size
    await writer.write(await file.slice(last_size,size).bytes())
    await writer.flush() 
    last_size = size
})
