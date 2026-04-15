# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

基于 Anthropic Agent SDK 的前端工作流：监听飞书群消息 → 自动领取前端开发任务 → 编码/commit/push → 反馈 MR 链接。

## Commands

```bash
bun install                    # 安装依赖
bun run index.ts --config      # 启动（默认 fed-workflow.yaml）
bun run index.ts --init        # 创建配置文件模板
bun run index.ts --list        # 查看飞书群组列表
bunx tsc --noEmit              # 类型检查（开发完成后验证）
```

## Architecture

```
index.ts ──→ src/cli.ts (入口：CLI解析 + 消息调度循环)
              ├── src/config.ts  (YAML配置读写，自动回填)
              ├── src/lark.ts    (飞书API + 消息监听 + 格式化)
              ├── src/agent.ts   (Agent SDK 调用：MCP工具 + coder子agent)
              ├── src/const.ts   (Zod schema + 类型 + 常量)
              └── src/log.ts     (分级日志，启动清空)
```

**核心数据流**：`lark.ts:debounceMessages()` 防抖收集消息 → `cli.ts:main()` 按群分发 → `agent.ts:run()` 调用 Agent SDK 处理 → 结果通过 MCP `send_message` 回群

**多群并行模型**：不同群并行，同群串行。`GroupState` 管理 pending/running 状态，同群任务完成后才处理下一批。

**Agent 层**：`run()` 通过 `query()` 调用 Agent SDK，配置了 lark MCP 工具（群详情/用户/图片/发消息）+ 外部 MCP（zhipu 搜索/阅读），以及 coder 子 agent（编码+类型检查+commit+push）。会话续接通过 `conversationId` 自动回填配置。

**const.ts 设计**：Zod schema 定义飞书消息结构，`larkContentSchema` 用 `transform` 链将原始 JSON 解析为联合类型 `LarkContent`——这是组合子思维的体现：schema 既是验证器也是解析器，通过 `.transform()` 链式组合完成 decode。

## Zen

1. 代码可读高于代码便捷
2. 只遵循一种解决路径（同一个事情不要用多种解决方案）
3. 运行时抛异常高于隐藏 Bug
4. TypeScript 类型检查优先于运行时抛异常
5. 不要想着局部最优解，敢于重构
6. 减少死记硬背的东西
7. 关注代码逻辑，代码风格无所谓

## About me

全栈工程师，编程哲学：

- **不可变思维**：数据流不可变，状态转换产生新对象
- **组合子思维**：用链式操作组合小函数构建复杂逻辑（参考 gpress 的 `G` 单子：`bind`/`map`/`alt`/`semiBind` 链式组合，OOP 点语法作为函数式语法糖）
- **OOP 点语法是函数式的语法糖**：方法链本质是函数组合，`a.bind(b).map(c)` ≡ `map(bind(b)(a))(c)`，点语法只是更易读的形式
