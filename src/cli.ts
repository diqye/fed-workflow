import { run } from "./agent";
import { debounceMessages, fetchChatDetail, fetchChatList, formatMessages } from "./lark";
import {parseArgs} from "util"

export async function main() {
    const version = "0.1"
    const parsed = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            version: {
                type: "boolean"
            },
            help: {
                type: "boolean"
            },
            list: {
                type: "boolean"
            },
            listen: {
                type: "string"
            },
            listenPrompt: {
                type: "string"
            },
            listenContinue: {
                type: "boolean"
            }
        }
    })

    if(parsed.values.version) {
        console.log("Version=",version)
        return
    }
    if(parsed.values.help) {
        console.log([
            "--version                    print version",
            "--help                       print this messages",
            "--list                       view chat list",
            "--listen          [chatId]   listen chat and run Agent",
            "--listenPrompt    [chatId]   append prompt together with --listen chat_id",
            "--listenContinue             Continue the most recent conversation in the current directory"
        ].join("\n"),version)
        return
    }
    if(parsed.values.list) {
        const list = await fetchChatList()
        console.log(list.data)
        return
    }

    if(parsed.values.listen == null) {
        console.log("Please run fedworkflow --help")
        return
    }
    const chatId = parsed.values.listen
    const appendPrompt = (()=>{
        const prompt = parsed.values.listenPrompt
        if(prompt) return prompt
        return ""
    })()

    const listenContinue = parsed.values.listenContinue ?? false


    console.log("chatId=",chatId)
    // 仅支持群
    const chatInfo = await fetchChatDetail(chatId)
    console.log("开始监听消息")
    console.log(chatInfo)

    let conversationId = null as string | null
    for await (const messages of debounceMessages()) {
        const messagesForChat = messages.filter(m=>m.event.message.chat_id == chatId)

        if(messagesForChat.length == 0) continue

        conversationId = await run(messagesForChat,{
            chatId,
            appendPrompt,
            conversationId,
            listenContinue 
        })
    }
}
