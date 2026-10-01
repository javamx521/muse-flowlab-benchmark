import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ProjectNameError, projectStore } from '../lib/projects'

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { hour12: false })
}

export default function HomePage() {
  const [keyword, setKeyword] = useState('')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const projects = useMemo(
    () => projectStore.search(keyword),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keyword, tick],
  )

  function refresh() {
    setTick((t) => t + 1)
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      projectStore.create(newName)
      setNewName('')
      refresh()
    } catch (err) {
      setError(err instanceof ProjectNameError ? err.message : '创建失败')
    }
  }

  function startRename(id: string, current: string) {
    setRenamingId(id)
    setRenameValue(current)
    setError(null)
  }

  function confirmRename(id: string) {
    setError(null)
    try {
      projectStore.rename(id, renameValue)
      setRenamingId(null)
      refresh()
    } catch (err) {
      setError(err instanceof ProjectNameError ? err.message : '重命名失败')
    }
  }

  function confirmDelete(id: string) {
    projectStore.remove(id)
    setDeletingId(null)
    refresh()
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
      </form>

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
            <li key={p.id} className="project-card">
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
    </main>
  )
}
