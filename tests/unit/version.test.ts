import { describe, expect, it } from 'vitest'
import { APP_VERSION, BUILD_TIME, GIT_SHA, isDevBuild, shortSha } from '../../src/lib/version'

describe('version', () => {
  it('版本号非空', () => {
    expect(APP_VERSION.length).toBeGreaterThan(0)
  })

  it('shortSha: dev 输入返回 dev', () => {
    expect(shortSha('dev')).toBe('dev')
  })

  it('shortSha: 真实 SHA 截取前 7 位', () => {
    expect(shortSha('abc1234567890')).toBe('abc1234')
  })

  it('shortSha: 默认读取构建注入的 GIT_SHA', () => {
    // 单元测试环境下构建常量未注入, 行为应与本地 dev 构建一致
    if (isDevBuild()) {
      expect(shortSha()).toBe('dev')
    } else {
      expect(shortSha()).toBe(GIT_SHA.slice(0, 7))
      expect(shortSha()).toHaveLength(7)
    }
  })

  it('BUILD_TIME 是合法的 ISO 时间字符串', () => {
    expect(new Date(BUILD_TIME).getTime()).not.toBeNaN()
  })
})
