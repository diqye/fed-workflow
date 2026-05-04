/**
 * 飞书消息监听
 */
import { spawn } from "bun"
import { Log } from "../log"
import { larkMessageSchema, type LarkMessage } from "./schemas"

function killExistingSubscriber() {
  try {
    const result = Bun.spawnSync([
      "pkill", "-f", "lark-cli event \\+subscribe"
    ])
    if (result.exitCode === 0) {
      Log.error("[killExistingSubscriber] 已杀掉旧实例")
    }
  } catch {}
}

export async function* listenLarkMessages(): AsyncGenerator<LarkMessage> {
  killExistingSubscriber()
  const proc = spawn({
    cmd: [
      "lark-cli",
      "event",
      "+subscribe",
      "--event-types", "im.message.receive_v1",
      "--quiet",
      "--as", "bot"
    ],
    stdout: "pipe",
    stderr: "inherit",
  });

  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read()
    if (done) break;

    const lineText = decoder.decode(value)
    Log.debug("[listenLarkMessages]", lineText)
    try {
      const message = JSON.parse(lineText)
      if (message.header?.event_type !== "im.message.receive_v1") continue
      yield larkMessageSchema.parse(message)
    } catch (e: any) {
      Log.error("[listenLarkMessages]", e.message)
    }
  }

  await proc.exited;
}
