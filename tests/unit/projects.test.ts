import { describe, expect, it, beforeEach } from 'vitest'
import {
  MAX_NAME_LENGTH,
  ProjectNameError,
  createMemoryStorage,
  createProjectStore,
  validateProjectName,
  type ProjectStore,
  type StorageLike,
} from '../../src/lib/projects'
import { PROJECTS_KEY } from '../../src/lib/storageKeys'

function memoryStorage(): StorageLike {
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

describe('validateProjectName', () => {
  it('接受普通名称并去除首尾空白', () => {
    expect(validateProjectName('  订单分析  ')).toBe('订单分析')
  })

  it('空名称抛 ProjectNameError', () => {
    expect(() => validateProjectName('')).toThrow(ProjectNameError)
    expect(() => validateProjectName('   ')).toThrow(ProjectNameError)
  })

  it('超长名称抛 ProjectNameError', () => {
    expect(() => validateProjectName('x'.repeat(MAX_NAME_LENGTH + 1))).toThrow(ProjectNameError)
  })

  it('恰好上限长度的名称通过', () => {
    expect(validateProjectName('x'.repeat(MAX_NAME_LENGTH))).toHaveLength(MAX_NAME_LENGTH)
  })
})

describe('createMemoryStorage', () => {
  it('set/get/remove 行为正确', () => {
    const s = createMemoryStorage()
    expect(s.getItem('k')).toBeNull()
    s.setItem('k', 'v')
    expect(s.getItem('k')).toBe('v')
    s.removeItem('k')
    expect(s.getItem('k')).toBeNull()
  })

  it('可作为 ProjectStore 的后端', () => {
    const store = createProjectStore(createMemoryStorage())
    const p = store.create('内存项目')
    expect(store.get(p.id)?.name).toBe('内存项目')
  })
})

describe('createProjectStore', () => {
  let storage: StorageLike
  let store: ProjectStore

  beforeEach(() => {
    storage = memoryStorage()
    store = createProjectStore(storage)
  })

  it('空存储返回空列表', () => {
    expect(store.list()).toEqual([])
  })

  it('创建项目返回带 id 与时间戳的元数据', () => {
    const p = store.create('测试项目')
    expect(p.id).toMatch(/^[0-9a-f-]{8,}/)
    expect(p.name).toBe('测试项目')
    expect(new Date(p.createdAt).getTime()).not.toBeNaN()
    expect(p.updatedAt).toBe(p.createdAt)
  })

  it('创建后可通过 list 与 get 读取', () => {
    const p = store.create('A')
    expect(store.list()).toHaveLength(1)
    expect(store.get(p.id)?.name).toBe('A')
    expect(store.get('不存在的id')).toBeUndefined()
  })

  it('创建非法名称时抛错且不写入', () => {
    expect(() => store.create('')).toThrow(ProjectNameError)
    expect(store.list()).toEqual([])
    expect(storage.getItem(PROJECTS_KEY)).toBeNull()
  })

  it('重命名更新名称与 updatedAt', () => {
    const p = store.create('旧名')
    const renamed = store.rename(p.id, '新名')
    expect(renamed.name).toBe('新名')
    expect(store.get(p.id)?.name).toBe('新名')
  })

  it('重命名不存在的项目抛错', () => {
    expect(() => store.rename('nope', 'x')).toThrow(/项目不存在/)
  })

  it('重命名非法名称抛错且原名保留', () => {
    const p = store.create('原名')
    expect(() => store.rename(p.id, '')).toThrow(ProjectNameError)
    expect(store.get(p.id)?.name).toBe('原名')
  })

  it('删除存在的项目返回 true, 之后不可见', () => {
    const p = store.create('待删除')
    expect(store.remove(p.id)).toBe(true)
    expect(store.get(p.id)).toBeUndefined()
    expect(store.list()).toEqual([])
  })

  it('删除不存在的项目返回 false', () => {
    expect(store.remove('nope')).toBe(false)
  })

  it('search 按名称子串过滤(大小写不敏感)', () => {
    store.create('订单分析')
    store.create('客户画像')
    store.create('Order Report')
    expect(store.search('订单')).toHaveLength(1)
    expect(store.search('order')).toHaveLength(1)
    expect(store.search('')).toHaveLength(3)
    expect(store.search('不存在')).toHaveLength(0)
  })

  it('list 按 updatedAt 倒序排列', async () => {
    const a = store.create('A')
    await new Promise((r) => setTimeout(r, 5))
    store.create('B')
    await new Promise((r) => setTimeout(r, 5))
    store.rename(a.id, 'A2') // A 的 updatedAt 变为最新
    const names = store.list().map((p) => p.name)
    expect(names[0]).toBe('A2')
  })

  it('损坏的 JSON 不抛错, 返回空列表', () => {
    storage.setItem(PROJECTS_KEY, '{坏掉的json')
    expect(store.list()).toEqual([])
  })

  it('非数组的 JSON 返回空列表', () => {
    storage.setItem(PROJECTS_KEY, '{"a":1}')
    expect(store.list()).toEqual([])
  })

  it('脏数据(缺字段)被过滤掉', () => {
    storage.setItem(PROJECTS_KEY, JSON.stringify([{ id: 'x' }, { id: 'y', name: '好' }]))
    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('好')
  })

  it('两次 create 生成不同 id', () => {
    const a = store.create('A')
    const b = store.create('B')
    expect(a.id).not.toBe(b.id)
  })
})
