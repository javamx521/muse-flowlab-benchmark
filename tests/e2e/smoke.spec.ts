import { test, expect } from '@playwright/test'

// M0 烟雾测试(已按 M1 新版编辑器 UI 更新): 验证应用可加载、项目 CRUD 真实可用、
// 深链接 404 态正常、页脚展示构建版本。
// 注意: 这是生产构建 + Hash 路由, 与 Pages 线上环境一致。

test('首页加载并显示标题与空态', async ({ page }) => {
  await page.goto('/#/')
  await expect(page).toHaveTitle(/FlowLab Studio/)
  await expect(page.getByRole('heading', { name: '项目列表' })).toBeVisible()
  await expect(page.getByTestId('empty-state')).toBeVisible()
})

test('创建项目 → 进入编辑器 → 返回', async ({ page }) => {
  await page.goto('/#/')
  await page.locator('#new-project-name').fill('冒烟测试项目')
  await page.getByRole('button', { name: '创建' }).click()

  const projectLink = page.getByRole('link', { name: '冒烟测试项目' })
  await expect(projectLink).toBeVisible()
  await projectLink.click()

  await expect(page).toHaveURL(/#\/project\/.+/)
  await expect(page.getByTestId('project-name')).toHaveText('冒烟测试项目')
  await expect(page.getByTestId('canvas')).toBeVisible()
  await expect(page.getByTestId('inspector-empty')).toBeVisible()

  await page.getByRole('link', { name: '← 项目' }).click()
  await expect(page).toHaveURL(/#\/$/)
  await expect(page.getByRole('link', { name: '冒烟测试项目' })).toBeVisible()
})

test('重命名与删除项目(含确认)', async ({ page }) => {
  await page.goto('/#/')
  await page.locator('#new-project-name').fill('待改名')
  await page.getByRole('button', { name: '创建' }).click()

  // 注意：点击重命名后卡片内名称变为输入框，hasText 过滤会失效，故用页面级定位
  await expect(page.getByRole('link', { name: '待改名' })).toBeVisible()
  await page.getByRole('button', { name: '重命名' }).click()
  await page.getByLabel('项目新名称').fill('已改名')
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('link', { name: '已改名' })).toBeVisible()

  await page.getByRole('button', { name: '删除' }).click()
  await page.getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByTestId('empty-state')).toBeVisible()
})

test('深链接到不存在的项目显示 404 态', async ({ page }) => {
  await page.goto('/#/project/does-not-exist-123')
  await expect(page.getByRole('heading', { name: '项目不存在' })).toBeVisible()
  await page.getByRole('link', { name: '返回项目列表' }).click()
  await expect(page).toHaveURL(/#\/$/)
})

test('未知路由显示页面不存在', async ({ page }) => {
  await page.goto('/#/')
  await page.goto('/#/no-such-route')
  await expect(page.getByRole('heading', { name: '页面不存在' })).toBeVisible()
})

test('页脚展示构建版本', async ({ page }) => {
  await page.goto('/#/')
  await expect(page.getByTestId('app-version')).toBeVisible()
})
