/**
 * 飞书发送消息 + 下载资源 + TTS 语音
 */
import { spawn } from "bun"
import { tmpdir } from "os"
import { join, parse } from "path"
import { mkdir } from "fs/promises"
import { Log } from "../log"
import { minimaxToken } from "../env"
import { DEFAULT_AUDIO_ID } from "../const"
import { larkApi } from "./api"

/**
 * 向飞书群/用户发送消息，支持 @人 和回复
 */
export async function sendMessage(chatId: string, text: string, mentionOpenIds: string[] = [], replyMessageId?: string): Promise<string> {
  const content = buildPostContent(text, mentionOpenIds)
  const body = {
    msg_type: "post",
    content: JSON.stringify(content),
  }

  if (replyMessageId) {
    const raw = await larkApi("POST", `/open-apis/im/v1/messages/${replyMessageId}/reply`, {
      data: JSON.stringify(body),
    })
    const { data } = JSON.parse(raw)
    return `已回复消息 ${data.message_id}`
  }

  const raw = await larkApi("POST", "/open-apis/im/v1/messages", {
    params: { receive_id_type: "chat_id" },
    data: JSON.stringify({ receive_id: chatId, ...body }),
  })
  const { data } = JSON.parse(raw)
  return `已发送消息 ${data.message_id}`
}

function buildPostContent(text: string, mentionOpenIds: string[]) {
  const paragraph: unknown[] = []

  for (const openId of mentionOpenIds) {
    paragraph.push({ tag: "at", user_id: openId })
  }

  if (text) {
    paragraph.push({ tag: "text", text })
  }

  return { zh_cn: { title: "", content: [paragraph] } }
}

/**
 * 发送图片消息（本地文件自动上传）
 */
export async function sendImageMessage(chatId: string, filePath: string): Promise<string> {
  const { dir, base } = parse(filePath)
  const proc = spawn({
    cmd: ["lark-cli", "im", "+messages-send", "--chat-id", chatId, "--image", base, "--as", "bot"],
    stdout: "pipe",
    stderr: "pipe",
    cwd: dir || ".",
  })
  const text = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`send image message failed: ${err}`)
  }
  const { data } = JSON.parse(text)
  return `已发送图片消息 ${data.message_id}`
}

/**
 * 发送文件消息（本地文件自动上传）
 */
export async function sendFileMessage(chatId: string, filePath: string): Promise<string> {
  const { dir, base } = parse(filePath)
  const proc = spawn({
    cmd: ["lark-cli", "im", "+messages-send", "--chat-id", chatId, "--file", base, "--as", "bot"],
    stdout: "pipe",
    stderr: "pipe",
    cwd: dir || ".",
  })
  const text = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`send file message failed: ${err}`)
  }
  const { data } = JSON.parse(text)
  return `已发送文件消息 ${data.message_id}`
}

/**
 * 下载消息中的资源（图片/文件），返回本地文件路径
 */
export async function fetchMessageResource(messageId: string, fileKey: string, type: "image" | "file", fileName?: string): Promise<string> {
  const dir = join(tmpdir(), `lark-${type}s`)
  await mkdir(dir, { recursive: true })
  const output = fileName ?? `${fileKey}.${type === "image" ? "png" : "bin"}`
  await larkApi("GET", `/open-apis/im/v1/messages/${messageId}/resources/${fileKey}`, {
    params: { type },
    output,
    cwd: dir,
  })
  return join(dir, output)
}

/**
 * TTS + 发送语音消息
 */
export async function sendAudioMessage(
  chatId: string,
  text: string,
  opts?: { voice_id?: string; emotion?: string; speed?: number }
): Promise<string> {
  const token = minimaxToken()
  if (!token) throw new Error("MINIMAX_KEY 未配置")

  const resp = await fetch("https://api.minimaxi.com/v1/t2a_v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: "speech-2.8-hd",
      text,
      stream: false,
      voice_setting: {
        voice_id: opts?.voice_id ?? DEFAULT_AUDIO_ID,
        speed: opts?.speed ?? 1,
        vol: 1,
        pitch: 0,
        emotion: opts?.emotion ?? "calm",
      },
      audio_setting: {
        format: "mp3",
        sample_rate: 32000,
        bitrate: 128000,
        channel: 1,
      },
    }),
  })

  const result = await resp.json() as any
  if (result.base_resp?.status_code !== 0) {
    const msg = `语音合成失败: ${result.base_resp?.status_msg ?? "未知错误"}`
    Log.error(msg)
    throw new Error(msg)
  }

  const mp3Buffer = Buffer.from(result.data.audio, "hex")
  const ts = Date.now()
  const tmpMp3 = join(tmpdir(), `tts-${ts}.mp3`)
  await Bun.write(tmpMp3, mp3Buffer)

  try {
    const { dir, base } = parse(tmpMp3)
    const uploadProc = spawn({
      cmd: ["lark-cli", "api", "POST", "/open-apis/im/v1/files",
            "--data", JSON.stringify({ file_type: "opus" }),
            "--file", `file=${base}`, "--as", "bot"],
      stdout: "pipe", stderr: "pipe",
      cwd: dir,
    })
    const uploadText = await new Response(uploadProc.stdout).text()
    const uploadExit = await uploadProc.exited
    if (uploadExit !== 0) {
      const err = await new Response(uploadProc.stderr).text()
      throw new Error(`飞书上传失败: ${err}`)
    }
    const uploadResult = JSON.parse(uploadText)
    const fileKey = uploadResult?.data?.file_key
    if (!fileKey) throw new Error(`飞书上传返回异常: ${uploadText}`)

    await larkApi("POST", "/open-apis/im/v1/messages", {
      params: { receive_id_type: "chat_id" },
      data: JSON.stringify({
        receive_id: chatId,
        msg_type: "audio",
        content: JSON.stringify({ file_key: fileKey }),
      }),
    })

    Log.info(`语音文件: ${tmpMp3}`)
    return "语音消息已发送"
  } catch (e) {
    Log.error(`语音发送失败: ${String(e)}`)
    throw e
  }
}
