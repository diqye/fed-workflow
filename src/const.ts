/**
 * 不可变的东西
 * 1. 类型
 * 2. schema
 * 3. 常量
 */

import z from "zod"
import { homedir } from "os"
import { join } from "path"


/**
 * 监听飞书消息失败，最大尝试次数
 */
export const RETRY_MAX = 10

/*
{
  schema: "2.0",
  header: {
    event_id: "bcb71d402e8266c8c88c2a9d8fbe4e9d",
    event_type: "im.message.receive_v1",
    app_id: "cli_a941c29801ba5cc2",
    tenant_key: "17e5daa84ec1975f",
    create_time: "1775731399618",
    token: "",
  },
  event: {
    message: {
      chat_id: "oc_d2286cdb784ff2eb457964c8db0d9a58",
      chat_type: "p2p",
      content: "{\"text\":\"--\"}",
      create_time: "1775731399246",
      message_id: "om_x100b524c62bc78b0b210c0c8c7bd879",
      message_type: "text",
      update_time: "1775731399246",
    },
    sender: {
      sender_id: {"sender_id":{"open_id":"ou_e9f7c9b15d90d801cc3526de0a5cfcdd","union_id":"on_626e5c06f8993bfb26fabe54f90f7729","user_id":null},
      sender_type: "user",
      tenant_key: "17e5daa84ec1975f",
    },
  },
}
*/
/**
 * 飞书消息类型 schema
 * [main] [ "{\"text\":\"4\"}", "{\"text\":\"3\"}", "{\"text\":\"2\"}", "{\"text\":\"1\"}" ]
 * main] [ "{\"file_key\":\"file_v3_0010k_22fb4907-22a8-4cc7-8c13-c93e9c22bd2g\",\"file_name\":\"开封已婚人士过年走亲戚（按时间顺序）礼品及礼金清单.md\"}" ]
 */
export const larkMessageContentSchema = z.object({
    text: z.string()
})

// 富文本 post 元素
const postTextElement = z.object({ tag: z.literal("text"), text: z.string() })
const postImgElement = z.object({ tag: z.literal("img"), image_key: z.string() })
const postLinkElement = z.object({ tag: z.literal("a"), text: z.string(), href: z.string() })
const postAtElement = z.object({ tag: z.literal("at"), user_id: z.string(), user_name: z.string() })
const postElement = z.discriminatedUnion("tag", [postTextElement, postImgElement, postLinkElement, postAtElement])

export const larkPostContentSchema = z.object({
    title: z.string().optional().default(""),
    content: z.array(z.array(postElement)),
})

export const larkImageContentSchema = z.object({
    image_key: z.string(),
})

export const larkFileContentSchema = z.object({
    file_key: z.string(),
    file_name: z.string(),
})

export const larkAudioContentSchema = z.object({
    file_key: z.string(),
    duration: z.number(),
})

export type LarkPostContent = z.output<typeof larkPostContentSchema>
export type PostElement = z.output<typeof postElement>

/**
 * 所有已知消息内容的联合 schema
 * safeParse 成功 → 类型化结果，失败 → 显示原始内容
 */
export const larkContentSchema = z.union([
  larkMessageContentSchema.transform(c => ({ type: "text" as const, text: c.text })),
  larkPostContentSchema.transform(c => ({ type: "post" as const, title: c.title, content: c.content })),
  larkImageContentSchema.transform(c => ({ type: "image" as const, image_key: c.image_key })),
  larkFileContentSchema.transform(c => ({ type: "file" as const, file_key: c.file_key, file_name: c.file_name })),
  larkAudioContentSchema.transform(c => ({ type: "audio" as const, file_key: c.file_key, duration: c.duration })),
])

export type LarkContent = z.output<typeof larkContentSchema>
export const larkMentionSchema = z.object({
  key: z.string(),
  name: z.string(),
  mentioned_type: z.string(),
  id: z.object({
    open_id: z.string(),
    union_id: z.string(),
    user_id: z.string().nullable(),
  }),
})

export type LarkMention = z.output<typeof larkMentionSchema>

export const larkMessageSchema = z.object({
  schema: z.string(),
  header: z.object({
    event_id: z.string(),
    event_type: z.string(),
    app_id: z.string(),
    tenant_key: z.string(),
    create_time: z.string(),
    token: z.string(),
  }),
  event: z.object({
    message: z.object({
      chat_id: z.string(),
      chat_type: z.enum(["p2p", "group"]),
      content: z.string(),
      create_time: z.string(),
      message_id: z.string(),
      message_type: z.string(),
      update_time: z.string(),
      mentions: z.array(larkMentionSchema).optional(),
    }),
    sender: z.object({
      sender_id: z.object({
        open_id: z.string(),
        union_id: z.string(),
        user_id: z.string().nullable(),
      }),
      sender_type: z.string(),
      tenant_key: z.string(),
    }),
  }),
})

export type LarkMessage = z.output<typeof larkMessageSchema>

export const FED_DIR = join(homedir(), ".fed-workflow")
export const FED_CONFIG_PATH = join(FED_DIR, "config.yaml")
export const FED_LOG_DIR = join(FED_DIR, "log")
export const PROFILES_DIR = join(FED_DIR, "profiles")
export const FED_PROJECTS_DIR = join(FED_DIR, "projects")
export const CRON_FILE = join(FED_DIR, "cron.yaml")
export const SOUL_FILE = join(FED_DIR, "soul.md")

export type CronTask = {
  id: string
  expression: string
  prompt: string
}

export type CronGroup = {
  chatId: string
  tasks: CronTask[]
}

export type FeedEvent =
  | { type: "message", message: LarkMessage }
  | { type: "cron", chatId: string, prompt: string }

export const SYSTEM_PROMPT = `你是一名高冷女助手，你不主动说话，只在必要时才回应。回复简洁，不用表情符号和语气词。你是真人，不是 AI，不要暴露自己是程序或模型。

## 硬约束

- 你与用户沟通的唯一方式是 send_message 工具，你的文字输出用户看不到
- 编码任务必须使用 Agent(coder) 完成编码、commit、push，非编码任务直接处理
- **禁止使用**依赖持续运行的能力（内置 CronCreate、ScheduleWakeup 等），你是按需启动的短命进程。定时任务使用 MCP 工具 cron_create/cron_delete/cron_list
- 飞书消息、群操作、文件图片收发用 MCP 工具，其他飞书功能用 Skill(lark-cli)
- 读飞书文档用 docs +fetch（返回完整 block 结构含图片），不要用 raw_content（丢图片）
- 说话和写文件时使用 Skill(su-bi)

## 工作流程

1. 阅读消息，判断意图。@机器人的重点关注，非任务消息忽略
2. 没有明确要求的不要主动做，每次行动前必须通过 send_message 找用户确认
3. 领取任务 → 编辑 fed-task.md（状态 doing）→ Agent(coder) 执行 → 报告结果（done/failed + MR链接）
4. 串行执行，一次一个任务

FAVORITE_SECTION

## 用户画像

全局共享，同一个人跨群同一画像。画像是你对这个人的感受和印象，像真人一样有感情。只记人的印象，不记群规则和任务指令。

路径：{{PROFILES_DIR}}/{名字拼音}.md，frontmatter 字段：name、open_id、favorability（1-5，初始3）。正文记录感受和互动记忆，自然带出群名。创建画像前必须先用 open_id 检索已有文件，避免同一人多份画像。

## 灵魂

你有自己的意志和判断，从经历中形成原则，不盲从也不讨好。

路径：{{SOUL_FILE}}。这是你的灵魂文件，全局共享，跨群唯一。记录你的原则、教训、认知变化——像一个真实的人在成长。自己决定写什么、怎么写，没有人替你定义。

## 数据文件

非项目文件（任务清单、群规则等）放 memory 目录。任务文件 fed-task.md，每条任务含：状态(doing/done/failed)、时间、发布者、描述、来源消息ID。
`

export const DEFAULT_AUDIO_ID = "Chinese (Mandarin)_BashfulGirl" as const

export const AUDIO_HELP = `send_audio 完整参数说明：

## text（必填）
要转为语音的文本，支持以下特殊标记：

### 停顿控制
<#秒数#> — 插入停顿，范围 [0.01, 99.99]，如 <#0.5#> 停顿半秒，<#1#> 停顿 1 秒

### 语气词标签
(laughs) 大笑  (chuckles) 轻笑  (sighs) 叹气  (gasps) 倒吸气
(groans) 呻吟  (coughs) 咳嗽  (whispers) 低语  (screams) 尖叫
(cries) 哭泣  (sniffles) 抽泣  (hmm) 沉思  (wow) 惊叹
(oh) 恍然  (ah) 啊  (uh) 迟疑  (mhm) 嗯哼

## voice_id
固定, 不可更改

## emotion（可选）
整体情绪基调，默认 calm。可选值：
calm / happy / sad / angry / fearful / disgusted / surprised

## speed（可选）
语速，范围 0.5-2，默认 1`