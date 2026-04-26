/**
 * 环境变量统一入口
 * 优先使用配置文件中的值，没有才用系统环境变量
 * （cli.ts 会在启动时将 config.env 注入 Bun.env，所以读 Bun.env 即可）
 */

export const zhipuToken = () => Bun.env["zhipu_token"] ?? ""
export const logLevel = () => Bun.env["LOG_LEVEL"] ?? "info"
export const minimaxToken = () => Bun.env["MINIMAX_KEY"] ?? ""
