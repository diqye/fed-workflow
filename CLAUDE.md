# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

基于 Anthropic Agent SDK 的群组智能助手。以飞书群为单位，为每个群提供独立的 Agent，承担开发、写作、研究等多种角色任务。Channel 抽象层解耦消息源，飞书是默认实现。

## Commands

```bash
bun install                    # 安装依赖
bun run index.ts               # 启动
bun run index.ts --init        # 创建配置文件模板
bun run index.ts --list        # 查看群组列表
bunx tsc --noEmit              # 类型检查（开发完成后验证）
```

## Architecture

```
index.ts ──→ src/cli.ts (入口：CLI解析 + 消息调度循环)
              ├── src/config.ts      (YAML配置读写，自动回填)
              ├── src/agent.ts       (Agent SDK 调用：MCP工具)
              ├── src/cronManager.ts (定时任务管理)
              ├── src/env.ts         (环境变量统一入口，禁止直接读 Bun.env)
              ├── src/const.ts       (常量 + 系统提示词)
              ├── src/log.ts         (分级日志，按日期覆盖)
              ├── src/message/
              │     types.ts         (Message, SendContent 等标准类型)
              │     channel.ts       (Channel 路由层 + feed 防抖 + cron 注入)
              │     userCache.ts     (用户缓存)
              └── src/lark/
                    index.ts         (LarkImpl — 飞书 Channel 实现)
                    schemas.ts       (飞书消息 Zod schema)
                    api.ts           (飞书 API 封装)
                    listen.ts        (消息监听)
                    send.ts          (消息发送 + 下载 + TTS)
                    format.ts        (消息格式化)
```

**核心数据流**：Channel.feed() 防抖收集消息 + cron 事件 → cli.ts 按群分发 → agent.ts:run() 调用 Agent SDK → 结果通过 MCP `send` 回群

**Channel 抽象**：chatId 统一带前缀（`lark:oc_xxx`），Channel 按前缀路由到对应 impl。新增消息源只需实现 `ChannelImpl` 接口。

**多群并行**：不同群并行，同群串行。`GroupState` 管理 pending/running 状态，同群任务完成后才处理下一批。

**const.ts 设计**：Zod schema 定义飞书消息结构，`larkContentSchema` 用 `transform` 链将原始 JSON 解析为联合类型 `LarkContent`——schema 既是验证器也是解析器，通过 `.transform()` 链式组合完成 decode。

## Zen

1. 代码可读高于代码便捷
2. 只遵循一种解决路径（同一个事情不要用多种解决方案）
3. 运行时抛异常高于隐藏 Bug
4. TypeScript 类型检查优先于运行时抛异常
5. 不要想着局部最优解，敢于重构
6. 减少死记硬背的东西
7. 关注代码逻辑，代码风格无所谓
8. 环境变量必须通过 src/env.ts 获取，禁止直接读 Bun.env

## About me

全栈工程师，编程哲学：

- **不可变思维**：数据流不可变，状态转换产生新对象
- **组合子思维**：用链式操作组合小函数构建复杂逻辑（参考 gpress 的 `G` 单子：`bind`/`map`/`alt`/`semiBind` 链式组合，OOP 点语法作为函数式语法糖）
- **OOP 点语法是函数式的语法糖**：方法链本质是函数组合，`a.bind(b).map(c)` ≡ `map(bind(b)(a))(c)`，点语法只是更易读的形式
