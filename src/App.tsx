import { useEffect, useState } from 'react'
import { HashRouter, Link, Route, Routes } from 'react-router-dom'
import HomePage from './pages/HomePage'
import EditorPage from './pages/EditorPage'
import { THEME_KEY } from './lib/storageKeys'
import { APP_VERSION, BUILD_TIME, shortSha } from './lib/version'
import { applySwUpdate, onSwUpdate, registerServiceWorker, type SwUpdateState } from './lib/serviceWorker'
import './app.css'

type Theme = 'light' | 'dark'

function getInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // 忽略存储异常, 回退到系统偏好
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return 'light'
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [swState, setSwState] = useState<SwUpdateState>('none')

  // Service Worker 注册与更新提示（M5）
  useEffect(() => {
    onSwUpdate(setSwState)
    void registerServiceWorker()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // 存储不可用时仅影响主题记忆, 不阻断使用
    }
  }, [theme])

  return (
    <HashRouter>
      <div className="app">
        <header className="app-header">
          <Link to="/" className="logo">
            FlowLab Studio
          </Link>
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
            aria-label={theme === 'light' ? '切换到深色主题' : '切换到浅色主题'}
          >
            {theme === 'light' ? '🌙 深色' : '☀️ 浅色'}
          </button>
        </header>

        {swState !== 'none' && (
          <div
            className="sw-banner"
            role="status"
            aria-live="polite"
            data-testid="sw-update-banner"
          >
            <span>
              {swState === 'available'
                ? '发现新版本，刷新后生效。'
                : '新版本已就绪，正在刷新…'}
            </span>
            {swState === 'available' && (
              <button
                data-testid="sw-update-btn"
                onClick={() => {
                  applySwUpdate()
                  // SW 接管后刷新页面
                  setTimeout(() => window.location.reload(), 800)
                }}
              >
                立即更新
              </button>
            )}
            <button
              data-testid="sw-dismiss-btn"
              onClick={() => setSwState('none')}
              aria-label="忽略本次更新提示"
            >
              稍后
            </button>
          </div>
        )}

        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/project/:id" element={<EditorPage />} />
          <Route
            path="*"
            element={
              <main className="page">
                <h1>页面不存在</h1>
                <p>
                  <Link to="/">返回项目列表</Link>
                </p>
              </main>
            }
          />
        </Routes>

        <footer className="app-footer">
          <span data-testid="app-version">
            FlowLab Studio v{APP_VERSION} · 构建 {shortSha()}
          </span>
          <span className="muted" title={BUILD_TIME}>
            数据仅保存在当前浏览器 · 清除网站数据可能丢失本地内容
          </span>
        </footer>
      </div>
    </HashRouter>
  )
}
