import { test } from "bun:test"
import { sendAudioMessage } from "../src/lark"
import { initLog } from "../src/log"

// 填入你的测试群 chatId
const CHAT_ID = "oc_d2286cdb784ff2eb457964c8db0d9a58"
initLog()

test("Send audio message", async () => {
  const result = await sendAudioMessage(CHAT_ID, "(laughs)你好，我是你的前端开发助手。<#0.5#>有什么任务可以交给我的，(sighs)不过别太简单的那种。")
  console.log(result)
})
