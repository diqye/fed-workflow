import { readFile, writeFile } from "fs/promises"
import type { Task, TaskStatus } from "./const"

const TASK_FILE = "fed-task.md"

export async function readTasks(): Promise<Task[]> {
  try {
    const raw = await readFile(TASK_FILE, "utf-8")
    return parseTaskMd(raw)
  } catch {
    return []
  }
}

export async function writeTasks(tasks: Task[]): Promise<void> {
  const md = tasks.map(formatTaskMd).join("\n\n")
  await writeFile(TASK_FILE, md + "\n", "utf-8")
}

export async function addTask(task: Task): Promise<void> {
  const tasks = await readTasks()
  tasks.push(task)
  await writeTasks(tasks)
}

export async function updateTaskStatus(sourceMessageId: string, status: TaskStatus): Promise<void> {
  const tasks = await readTasks()
  const task = tasks.find(t => t.source_message_id === sourceMessageId)
  if (task) {
    task.status = status
    await writeTasks(tasks)
  }
}

function formatTaskMd(task: Task): string {
  return `## ${task.title}
- **状态**: ${task.status}
- **来源消息**: \`${task.source_message_id}\``
}

function parseTaskMd(raw: string): Task[] {
  const tasks: Task[] = []
  const blocks = raw.split(/^## /m).filter(Boolean)

  for (const block of blocks) {
    const titleMatch = block.match(/^(.+)\n/)
    const statusMatch = block.match(/\*\*状态\*\*:\s*(pending|doing|done|failed)/)
    const msgIdMatch = block.match(/\*\*来源消息\*\*:\s*`(.+?)`/)

    if (titleMatch && statusMatch && msgIdMatch) {
      tasks.push({
        title: titleMatch[1]!.trim(),
        status: statusMatch[1]! as TaskStatus,
        source_message_id: msgIdMatch[1]!,
      })
    }
  }

  return tasks
}
