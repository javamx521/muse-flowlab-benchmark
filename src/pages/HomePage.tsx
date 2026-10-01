/**
 * 项目列表页（M3）。
 * 项目注册表改为 IndexedDB 异步实现；支持导入工程文件、复制项目。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ProjectNameError } from '../lib/projects'
import type { ProjectMeta } from '../lib/projects'
import { getBackend, getProjectStore } from '../store/appStores'
import type { AsyncProjectStore } from '../store/indexedDb'
import { parseImport, adoptImported } from '../store/exportImport'

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { hour12: false })
}

export default function HomePage() {
  const [store, setStore] = useState<AsyncProjectStore | null>(null)
  const [storeError, setStoreError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [importError, setImportError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    getProjectStore()
      .then((s) => {
        if (alive) setStore(s)
      })
      .catch((err) => {
        if (alive) setStoreError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!store) return
    try {
      setProjects(await store.search(keyword))
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    }
  }, [store, keyword])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!store) return
    setError(null)
    try {
      await store.create(newName)
      setNewName('')
      await refresh()
    } catch (err) {
      setError(err instanceof ProjectNameError ? err.message : '创建失败')
    }
  }

  function startRename(id: string, current: string) {
    setRenamingId(id)
    setRenameValue(current)
    setError(null)
  }

  async function confirmRename(id: string) {
    if (!store) return
    setError(null)
    try {
      await store.rename(id, renameValue)
      setRenamingId(null)
      await refresh()
    } catch (err) {
      setError(err instanceof ProjectNameError ? err.message : '重命名失败')
    }
  }

  async function handleCopy(id: string) {
    if (!store) return
    setError(null)
    try {
      await store.copy(id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '复制失败')
    }
  }

  async function confirmDelete(id: string) {
    if (!store) return
    await store.remove(id)
    setDeletingId(null)
    await refresh()
  }

  /** 导入工程文件：校验+迁移后创建独立新项目，绝不覆盖现有项目。 */
  async function handleImportFile(file: File) {
    if (!store) return
    setImportError(null)
    try {
      const text = await file.text()
      const parsed = parseImport(text)
      if (!parsed.ok) {
        setImportError(`导入失败：${parsed.error}`)
        return
      }
      const meta = await store.create(parsed.doc.name)
      const adopted = adoptImported(parsed.doc, meta.id, meta.name)
      await getBackend().save(adopted)
      await refresh()
    } catch (err) {
      setImportError(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  if (storeError) {
    return (
      <main className="page">
        <h1>项目列表</h1>
        <p role="alert">存储初始化失败：{storeError}</p>
      </main>
    )
  }
  if (!store) {
    return (
      <main className="page">
        <h1>项目列表</h1>
        <p>加载中…</p>
      </main>
    )
  }

  return (
    <main className="page">
      <h1>项目列表</h1>

      <form className="row" onSubmit={handleCreate} aria-label="新建项目">
        <label htmlFor="new-project-name">新建项目</label>
        <input
          id="new-project-name"
          type="text"
          value={newName}
          maxLength={100}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="输入项目名称"
        />
        <button type="submit">创建</button>
        <button type="button" data-testid="import-btn" onClick={() => fileRef.current?.click()} title="从 .flowlab.json 文件导入工程（创建独立新项目）">
          导入工程
        </button>
        <input
          ref={fileRef}
          data-testid="import-file"
          type="file"
          accept=".json,.flowlab.json,application/json"
          style={{ display: 'none' }}
          aria-label="选择工程文件"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleImportFile(f)
          }}
        />
      </form>

      {importError && (
        <p className="error" role="alert" data-testid="import-error">
          {importError}
        </p>
      )}

      <div className="row">
        <label htmlFor="project-search">搜索</label>
        <input
          id="project-search"
          type="search"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="按名称搜索项目"
        />
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {projects.length === 0 ? (
        <div className="empty" data-testid="empty-state">
          <p>还没有项目。创建一个项目开始使用 FlowLab Studio。</p>
        </div>
      ) : (
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id} className="project-card" data-testid={`project-card-${p.id}`}>
              {renamingId === p.id ? (
                <div className="row">
                  <input
                    aria-label="项目新名称"
                    type="text"
                    value={renameValue}
                    maxLength={100}
                    onChange={(e) => setRenameValue(e.target.value)}
                    autoFocus
                  />
                  <button type="button" onClick={() => confirmRename(p.id)}>
                    保存
                  </button>
                  <button type="button" onClick={() => setRenamingId(null)}>
                    取消
                  </button>
                </div>
              ) : (
                <>
                  <Link to={`/project/${p.id}`} className="project-name">
                    {p.name}
                  </Link>
                  <span className="project-meta">更新于 {formatTime(p.updatedAt)}</span>
                  <div className="row">
                    <button type="button" onClick={() => startRename(p.id, p.name)}>
                      重命名
                    </button>
                    <button type="button" data-testid={`copy-${p.id}`} onClick={() => handleCopy(p.id)} title="复制为独立新项目">
                      复制
                    </button>
                    {deletingId === p.id ? (
                      <>
                        <span>确定删除吗?</span>
                        <button type="button" onClick={() => confirmDelete(p.id)}>
                          确认删除
                        </button>
                        <button type="button" onClick={() => setDeletingId(null)}>
                          取消
                        </button>
                      </>
                    ) : (
                      <button type="button" onClick={() => setDeletingId(p.id)}>
                        删除
                      </button>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">项目数据默认只保存在当前浏览器（IndexedDB）。请用编辑器内的「导出」备份工程；清除网站数据可能丢失本地内容。</p>
    </main>
  )
}
