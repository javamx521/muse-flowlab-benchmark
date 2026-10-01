// 构建版本信息: 由 vite.config.ts 在构建时注入。
// 本地开发构建显示 dev; CI 构建注入真实的 commit SHA 与构建时间。
// 页面页脚展示这些信息, 用于线上版本核验(任务书 §6.7)。
//
// 注意: vite define 对下面的标识符做构建时文本替换。
// typeof 守卫保证在未注入的环境(单元测试)下不会抛 ReferenceError。

declare const __FLOWLAB_VERSION__: string
declare const __FLOWLAB_GIT_SHA__: string
declare const __FLOWLAB_BUILD_TIME__: string

function injected(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

const VERSION: string | undefined =
  typeof __FLOWLAB_VERSION__ !== 'undefined' ? __FLOWLAB_VERSION__ : undefined
const SHA: string | undefined =
  typeof __FLOWLAB_GIT_SHA__ !== 'undefined' ? __FLOWLAB_GIT_SHA__ : undefined
const TIME: string | undefined =
  typeof __FLOWLAB_BUILD_TIME__ !== 'undefined' ? __FLOWLAB_BUILD_TIME__ : undefined

export const APP_VERSION: string = injected(VERSION, '0.0.0-dev')
export const GIT_SHA: string = injected(SHA, 'dev')
export const BUILD_TIME: string = injected(TIME, new Date(0).toISOString())

export function shortSha(sha: string = GIT_SHA): string {
  if (sha === 'dev') return 'dev'
  return sha.slice(0, 7)
}

export function isDevBuild(): boolean {
  return GIT_SHA === 'dev'
}
