import { test, expect, type Page, type TestInfo } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// M3 端到端测试（F06 撤销/重做、F07 持久化/快照/导入导出/多标签页冲突）。
// 在生产构建 + 真实 IndexedDB 上运行，全部真实交互、真实断言。

/**
 * 可上传的固件路径：必须全 ASCII。
 * 实测 Playwright 在此环境对含中文字符的路径 setInputFiles 会静默失败（change 不触发），
 * 而 testInfo.outputPath 的目录名来自中文测试标题，故改用系统临时目录。
 */
function asciiFixturePath(testInfo: TestInfo, name: string): string {
  const safeId = testInfo.testId.replace(/[^a-zA-Z0-9]/g, '_')
  return path.join(os.tmpdir(), `flowlab-${safeId}-${name}`)
}

async function createProject(page: Page, name: string) {
  await page.goto('/#/')
  await page.locator('#new-project-name').fill(name)
  await page.getByRole('button', { name: '创建' }).click()
  await page.getByRole('link', { name }).click()
  await expect(page).toHaveURL(/#\/project\/.+/)
  await expect(page.getByTestId('canvas')).toBeVisible()
}

async function nodeIds(page: Page): Promise<string[]> {
  const tids = await page
    .locator('[data-testid="canvas"] g[data-testid^="node-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  return tids
    .filter((t): t is string => !!t && t.startsWith('node-'))
    .map((t) => t.slice('node-'.length))
}

/** 等待一次保存周期完成（保存中… → 已保存）。 */
async function waitSaved(page: Page) {
  const status = page.getByTestId('save-status')
  await expect(status).toHaveText('保存中…', { timeout: 8000 })
  await expect(status).toHaveText('已保存', { timeout: 20000 })
}

test('M3 撤销重做：添加 → 撤销 → 重做', async ({ page }) => {
  await createProject(page, 'M3 撤销')
  const undoBtn = page.getByTestId('undo-btn')
  const redoBtn = page.getByTestId('redo-btn')
  await expect(undoBtn).toBeDisabled()
  await expect(redoBtn).toBeDisabled()

  await page.getByTestId('add-output').click()
  const [id] = await nodeIds(page)
  expect(id).toBeTruthy()
  await expect(undoBtn).toBeEnabled()

  await undoBtn.click()
  await expect(page.getByTestId(`node-${id}`)).toHaveCount(0)
  await expect(undoBtn).toBeDisabled()
  await expect(redoBtn).toBeEnabled()

  await redoBtn.click()
  await expect(page.getByTestId(`node-${id}`)).toHaveCount(1)
  await expect(undoBtn).toBeEnabled()
})

test('M3 快捷键撤销：一次连续拖拽只产生一条历史', async ({ page }) => {
  await createProject(page, 'M3 拖拽')
  await page.getByTestId('add-output').click()
  const [id] = await nodeIds(page)
  const node = page.getByTestId(`node-${id}`)
  const before = await node.getAttribute('transform')
  expect(before).toBeTruthy()

  const box = await node.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + 60, box!.y + 20)
  await page.mouse.down()
  await page.mouse.move(box!.x + 260, box!.y + 140, { steps: 15 })
  await page.mouse.up()
  const after = await node.getAttribute('transform')
  expect(after).not.toBe(before)

  // 一次 Ctrl+Z 必须整体回到拖拽前位置（而不是中间某一步）
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => node.getAttribute('transform'), { timeout: 5000 }).toBe(before)
})

test('M3 刷新恢复：已保存项目刷新后节点仍在', async ({ page }) => {
  await createProject(page, 'M3 刷新')
  await page.getByTestId('add-output').click()
  const [id] = await nodeIds(page)
  await waitSaved(page)
  await page.reload()
  await expect(page.getByTestId('canvas')).toBeVisible()
  await expect(page.getByTestId(`node-${id}`)).toBeVisible({ timeout: 15000 })
})

test('M3 快照：创建 → 比较差异 → 恢复', async ({ page }) => {
  await createProject(page, 'M3 快照')
  await page.getByTestId('add-output').click()
  const [id1] = await nodeIds(page)

  page.on('dialog', (d) => void d.accept())
  await page.getByTestId('snapshot-btn').click()
  await page.getByTestId('snapshot-name').fill('基线')
  await page.getByTestId('snapshot-create').click()
  await expect(page.locator('.snapshot-list li', { hasText: '基线' })).toBeVisible()
  await page.getByRole('button', { name: '关闭' }).click()

  // 修改图：再加一个节点
  await page.getByTestId('add-filter').click()
  expect(await nodeIds(page)).toHaveLength(2)

  // 比较：应显示新增节点
  await page.getByTestId('snapshot-btn').click()
  await page.locator('.snapshot-list li', { hasText: '基线' }).getByRole('button', { name: '与当前比较' }).click()
  const diff = page.getByTestId('snapshot-diff')
  await expect(diff).toBeVisible()
  await expect(diff).toContainText('新增节点')

  // 恢复快照：第二个节点消失，且恢复本身可撤销
  await page.locator('.snapshot-list li', { hasText: '基线' }).getByRole('button', { name: '恢复' }).click()
  await expect.poll(async () => nodeIds(page), { timeout: 5000 }).toHaveLength(1)
  expect(await nodeIds(page)).toEqual([id1])
  // 恢复可撤销：Ctrl+Z 回到 2 节点
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => nodeIds(page), { timeout: 5000 }).toHaveLength(2)
})

test('M3 导出导入往返：新浏览器可恢复', async ({ page }) => {
  await createProject(page, 'M3 导出')
  await page.getByTestId('add-output').click()
  await waitSaved(page)

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-btn').click(),
  ])
  const dlPath = await download.path()
  expect(dlPath).toBeTruthy()

  // 回到首页导入
  await page.goto('/#/')
  await page.locator('input[data-testid="import-file"]').setInputFiles(dlPath!)
  await expect(page.getByRole('link', { name: 'M3 导出' }).first()).toBeVisible({ timeout: 15000 })
  // 打开导入的项目：节点应存在（独立新项目）
  await page.getByRole('link', { name: 'M3 导出' }).first().click()
  await expect(page.getByTestId('canvas')).toBeVisible()
  expect(await nodeIds(page)).toHaveLength(1)
})

test('M3 旧格式 v1 工程导入并迁移', async ({ page }, testInfo) => {
  const v1 = {
    kind: 'flowlab-studio-export',
    appVersion: '0.1.0',
    exportedAt: '2026-09-01T00:00:00.000Z',
    document: {
      id: 'v1-proj',
      name: 'V1 旧工程',
      version: 1,
      graph: {
        nodes: [{ id: 'n1', kind: 'output', name: '输出 1', params: {}, position: { x: 100, y: 100 } }],
        edges: [],
        revision: 1,
      },
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  }
  const fpath = asciiFixturePath(testInfo, 'v1.flowlab.json')
  fs.writeFileSync(fpath, JSON.stringify(v1))

  await page.goto('/#/')
  await page.locator('input[data-testid="import-file"]').setInputFiles(fpath)
  await expect(page.getByRole('link', { name: 'V1 旧工程' })).toBeVisible({ timeout: 15000 })
  await page.getByRole('link', { name: 'V1 旧工程' }).click()
  await expect(page.getByTestId('canvas')).toBeVisible()
  // v1 节点被迁移保留
  await expect(page.getByTestId('node-n1')).toBeVisible({ timeout: 15000 })
})

test('M3 损坏文件导入：报错且不清空现有项目', async ({ page }, testInfo) => {
  await createProject(page, 'M3 损坏导入对照')
  const before = await nodeIds(page)
  const fpath = asciiFixturePath(testInfo, 'bad.flowlab.json')
  fs.writeFileSync(fpath, '{ not json')

  await page.goto('/#/')
  await page.locator('input[data-testid="import-file"]').setInputFiles(fpath)
  await expect(page.getByTestId('import-error')).toContainText('导入失败', { timeout: 15000 })
  // 现有项目不受影响
  await page.getByRole('link', { name: 'M3 损坏导入对照' }).click()
  await expect(page.getByTestId('canvas')).toBeVisible()
  expect(await nodeIds(page)).toEqual(before)
})

test('M3 复制项目：独立副本互不影响', async ({ page }) => {
  await createProject(page, 'M3 复制源')
  await page.getByTestId('add-output').click()
  await waitSaved(page)
  await page.goto('/#/')

  const card = page.locator('.project-card', { hasText: 'M3 复制源' }).first()
  await card.getByRole('button', { name: '复制' }).click()
  const copyCard = page.locator('.project-card', { hasText: 'M3 复制源 副本' })
  await expect(copyCard).toBeVisible({ timeout: 15000 })

  // 副本中节点存在
  await copyCard.getByRole('link').click()
  await expect(page.getByTestId('canvas')).toBeVisible()
  expect(await nodeIds(page)).toHaveLength(1)
  // 副本中新增节点
  await page.getByTestId('add-filter').click()
  await waitSaved(page)
  expect(await nodeIds(page)).toHaveLength(2)

  // 原项目仍只有 1 个节点（独立）；用精确链接文本避免误匹配"副本"卡片
  await page.goto('/#/')
  await page.getByRole('link', { name: 'M3 复制源', exact: true }).click()
  await expect(page.getByTestId('canvas')).toBeVisible()
  await expect.poll(async () => nodeIds(page), { timeout: 15000 }).toHaveLength(1)
})

test('M3 多标签页冲突：B 先保存 → A 冲突 → 另存为副本', async ({ browser }) => {
  const context = await browser.newContext()
  const pageA = await context.newPage()
  const pageB = await context.newPage()

  await createProject(pageA, 'M3 冲突')
  const url = pageA.url()
  await expect(pageA.getByTestId('save-status')).toHaveText('已保存', { timeout: 20000 })

  await pageB.goto(url)
  await expect(pageB.getByTestId('canvas')).toBeVisible()
  await expect(pageB.getByTestId('save-status')).toHaveText('已保存', { timeout: 20000 })

  // B 先修改并保存
  await pageB.getByTestId('add-output').click()
  await waitSaved(pageB)
  expect(await nodeIds(pageB)).toHaveLength(1)

  // A 再修改 → 自动保存时 rev 过期 → 冲突对话框（本地修改保留）
  await pageA.getByTestId('add-filter').click()
  await expect(pageA.getByTestId('conflict-dialog')).toBeVisible({ timeout: 20000 })

  // 另存为副本：新项目、含 A 的本地修改
  await pageA.getByTestId('conflict-copy').click()
  await expect(pageA).toHaveURL(/#\/project\/.+/, { timeout: 20000 })
  expect(pageA.url()).not.toBe(url)
  await expect(pageA.getByTestId('canvas')).toBeVisible()
  await expect.poll(async () => nodeIds(pageA), { timeout: 15000 }).toHaveLength(1)

  // 原项目仍是 B 的版本（1 个 output 节点），未被 A 静默覆盖
  await pageB.reload()
  await expect(pageB.getByTestId('canvas')).toBeVisible()
  await expect.poll(async () => nodeIds(pageB), { timeout: 15000 }).toHaveLength(1)

  await context.close()
})
