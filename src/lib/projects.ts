// 项目元数据存储。
// M0 使用 localStorage 实现真实的创建/重命名/删除/搜索;
// M3 将迁移到 IndexedDB(见 docs/DECISIONS.md D-004)。
// 存储实现通过 StorageLike 注入, 便于单元测试使用内存实现。

import { PROJECTS_KEY } from './storageKeys'

export interface ProjectMeta {
  id: string
  name: string
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const MAX_NAME_LENGTH = 100

export class ProjectNameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectNameError'
  }
}

export function validateProjectName(raw: string): string {
  const name = raw.trim()
  if (name.length === 0) {
    throw new ProjectNameError('项目名称不能为空')
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new ProjectNameError(`项目名称不能超过 ${MAX_NAME_LENGTH} 个字符`)
  }
  return name
}

function readAll(storage: StorageLike): ProjectMeta[] {
  const raw = storage.getItem(PROJECTS_KEY)
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is ProjectMeta =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as ProjectMeta).id === 'string' &&
        typeof (p as ProjectMeta).name === 'string',
    )
  } catch {
    // 损坏的数据不抛错: 返回空列表, 由调用方决定是否提示用户。
    // 不得静默覆盖: writeAll 只在明确的写操作时执行。
    return []
  }
}

function writeAll(storage: StorageLike, projects: ProjectMeta[]): void {
  storage.setItem(PROJECTS_KEY, JSON.stringify(projects))
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `p-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

export interface ProjectStore {
  list(): ProjectMeta[]
  search(keyword: string): ProjectMeta[]
  get(id: string): ProjectMeta | undefined
  create(name: string): ProjectMeta
  rename(id: string, name: string): ProjectMeta
  remove(id: string): boolean
}

export function createProjectStore(storage: StorageLike): ProjectStore {
  return {
    list(): ProjectMeta[] {
      return readAll(storage).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },

    search(keyword: string): ProjectMeta[] {
      const kw = keyword.trim().toLowerCase()
      if (kw === '') return this.list()
      return this.list().filter((p) => p.name.toLowerCase().includes(kw))
    },

    get(id: string): ProjectMeta | undefined {
      return readAll(storage).find((p) => p.id === id)
    },

    create(name: string): ProjectMeta {
      const valid = validateProjectName(name)
      const now = new Date().toISOString()
      const project: ProjectMeta = { id: newId(), name: valid, createdAt: now, updatedAt: now }
      const all = readAll(storage)
      all.push(project)
      writeAll(storage, all)
      return project
    },

    rename(id: string, name: string): ProjectMeta {
      const valid = validateProjectName(name)
      const all = readAll(storage)
      const target = all.find((p) => p.id === id)
      if (!target) throw new Error(`项目不存在: ${id}`)
      target.name = valid
      target.updatedAt = new Date().toISOString()
      writeAll(storage, all)
      return target
    },

    remove(id: string): boolean {
      const all = readAll(storage)
      const kept = all.filter((p) => p.id !== id)
      if (kept.length === all.length) return false
      writeAll(storage, kept)
      return true
    },
  }
}

// 非浏览器环境(单元测试/SSR)使用的内存存储实现, 导出以便直接测试。
export function createMemoryStorage(): StorageLike {
  const mem = new Map<string, string>()
  return {
    getItem: (k) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k, v) => {
      mem.set(k, v)
    },
    removeItem: (k) => {
      mem.delete(k)
    },
  }
}

// 浏览器默认实例。非浏览器环境使用内存兜底, 避免模块加载时抛错。
function defaultStorage(): StorageLike {
  if (typeof localStorage !== 'undefined') return localStorage
  return createMemoryStorage()
}

export const projectStore: ProjectStore = createProjectStore(defaultStorage())
