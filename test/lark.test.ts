import {test} from "bun:test"
import { fetchBotInfo } from "../src/lark"

test("Fetch bot info",async () => {
    const info = await fetchBotInfo()
    console.log(info)
})