import { test } from "bun:test"
import { sendMessage, sendImageMessage, sendFileMessage } from "../src/lark"

// 填入你的测试群 chatId
const CHAT_ID = "oc_d2286cdb784ff2eb457964c8db0d9a58"

test("Send text message", async () => {
  const result = await sendMessage(CHAT_ID, "Hello from fed-workflow test!")
  console.log(result)
})

test("Send message with @mention", async () => {
  const result = await sendMessage(CHAT_ID, " 这是一条测试消息", ["ou_e9f7c9b15d90d801cc3526de0a5cfcdd"])
  console.log(result)
})

test("Send image message", async () => {
  const result = await sendImageMessage(CHAT_ID, "test/test-image.png")
  console.log(result)
})

test("Send file message", async () => {
  const result = await sendFileMessage(CHAT_ID, "test/lark.test.ts")
  console.log(result)
})
