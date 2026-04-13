/**
 * 不可变的东西
 * 1. 类型
 * 2. schema
 * 3. 常量
 */

import z from "zod"


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

/**
 * 任务状态
 */
export type TaskStatus = "pending" | "doing" | "done" | "failed"

export const taskSchema = z.object({
  title: z.string(),
  status: z.enum(["pending", "doing", "done", "failed"]),
  source_message_id: z.string(),
})

export type Task = z.output<typeof taskSchema>

export const LOG_LEVEL = Bun.env["LOG_LEVEL"] ?? "debug"

export const ZHIPU_TOKEN = Bun.env["zhipu_token"] ?? ""