/**
 * 飞书消息 Zod schema + 类型
 * 从 const.ts 迁出
 */
import z from "zod"

const larkMessageContentSchema = z.object({
  text: z.string(),
})

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
