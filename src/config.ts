import { readFile, writeFile } from "fs/promises"
import YAML from "yaml"
import { Log } from "./log"
import type { Config, ProjectConfig } from "./const"

export type { Config, ProjectConfig }

export async function loadConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf-8")
  const data = YAML.parse(raw)
  if (!data || !Array.isArray(data.projects)) {
    throw new Error(`配置文件格式错误: ${path}`)
  }
  return data as Config
}

export async function saveConfig(path: string, config: Config): Promise<void> {
  const raw = YAML.stringify(config)
  await writeFile(path, raw, "utf-8")
  Log.debug("[config] saved:", path)
}

/**
 * 更新单个项目配置并保存
 */
export async function updateProject(path: string, config: Config, chatId: string, patch: Partial<ProjectConfig>): Promise<void> {
  const project = config.projects.find(p => p.chatId === chatId)
  if (!project) return
  Object.assign(project, patch)
  await saveConfig(path, config)
}

/**
 * 新增项目配置并保存
 */
export async function addProject(path: string, config: Config, project: ProjectConfig): Promise<void> {
  config.projects.push(project)
  await saveConfig(path, config)
}
