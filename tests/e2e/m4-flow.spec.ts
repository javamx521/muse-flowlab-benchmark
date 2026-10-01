import { test, expect, type Page } from '@playwright/test'

// M4 端到端测试（F08 增量缓存可观察性、表格虚拟化、缓存清除）。
// 在生产构建 + 真实 Web Worker 上运行，全部真实交互、真实断言。

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

async function connect(page: Page, sourceId: string, targetId: string, outPort = 'out', inPort = 'in') {
  const out = page.getByTestId(`port-out-${outPort}-${sourceId}`)
  const inp = page.getByTestId(`port-in-${inPort}-${targetId}`)
  const outBox = await out.boundingBox()
  const inBox = await inp.boundingBox()
  expect(outBox, '输出端口可见').not.toBeNull()
  expect(inBox, '输入端口可见').not.toBeNull()
  await page.mouse.move(outBox!.x + outBox!.width / 2, outBox!.y + outBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(inBox!.x + inBox!.width / 2, inBox!.y + inBox!.height / 2, { steps: 12 })
  await page.mouse.up()
}

async function selectNode(page: Page, id: string) {
  await page.getByTestId(`node-${id}`).click()
  await expect(page.getByTestId('inspector')).toBeVisible()
}

/** 运行并等待运行日志出现，返回 cache-summary 文本。 */
async function runAndWaitCacheSummary(page: Page): Promise<string> {
  await page.getByTestId('run-btn').click()
  await page.getByTestId('tab-log').click()
  const summary = page.getByTestId('cache-summary')
  await expect(summary).toBeVisible({ timeout: 60000 })
  return (await summary.textContent()) ?? ''
}

test('M4 增量缓存：二次运行全部命中，改参数后仅下游失效', async ({ page }) => {
  await createProject(page, 'M4 缓存')
  await page.getByTestId('add-synthetic-input').click()
  await page.getByTestId('add-filter').click()
  await page.getByTestId('add-output').click()
  const [synId, filterId, outId] = await nodeIds(page)
  await connect(page, synId!, filterId!)
  await connect(page, filterId!, outId!)

  // 第一次运行：0 命中
  const s1 = await runAndWaitCacheSummary(page)
  expect(s1).toContain('0 个节点命中缓存')

  // 第二次运行：全部命中（可观察证据：徽标 + 汇总）
  const s2 = await runAndWaitCacheSummary(page)
  expect(s2).toContain('3 个节点命中缓存')
  await expect(page.getByTestId(`cache-hit-${synId}`)).toBeVisible()
  await expect(page.getByTestId(`cache-hit-${filterId}`)).toBeVisible()
  await expect(page.getByTestId(`cache-hit-${outId}`)).toBeVisible()

  // 修改 filter 条件：只有 synthetic-input 命中，下游重算
  await selectNode(page, filterId!)
  await page.getByTestId('param-condition').fill('$age >= 30')
  const s3 = await runAndWaitCacheSummary(page)
  expect(s3).toContain('1 个节点命中缓存')
  await expect(page.getByTestId(`cache-hit-${synId}`)).toBeVisible()
  await expect(page.getByTestId(`cache-hit-${filterId}`)).toHaveCount(0)
})

test('M4 清除缓存：清空后下次运行全部重算', async ({ page }) => {
  await createProject(page, 'M4 清缓存')
  await page.getByTestId('add-synthetic-input').click()
  await page.getByTestId('add-output').click()
  const [synId, outId] = await nodeIds(page)
  await connect(page, synId!, outId!)

  await runAndWaitCacheSummary(page)
  const s2 = await runAndWaitCacheSummary(page)
  expect(s2).toContain('2 个节点命中缓存')

  await page.getByTestId('clear-cache').click()
  const s3 = await runAndWaitCacheSummary(page)
  expect(s3).toContain('0 个节点命中缓存')
  // 重跑后缓存被重新填充（行为正确：清空只影响下一次运行的命中）
  await expect(page.getByTestId('cache-summary')).toContainText('缓存中共 2 条')
})

test('M4 表格虚拟化：5000 行只渲染窗口', async ({ page }) => {
  await createProject(page, 'M4 虚拟化')
  await page.getByTestId('add-synthetic-input').click()
  await page.getByTestId('add-output').click()
  const [synId, outId] = await nodeIds(page)
  await connect(page, synId!, outId!)

  await selectNode(page, synId!)
  await page.getByTestId('param-rows').fill('5000')
  await page.getByTestId('run-btn').click()

  // 选中 output 查看全量输出
  await selectNode(page, outId!)
  const table = page.getByTestId('datatable')
  await expect(table).toBeVisible({ timeout: 60000 })
  await expect(page.getByTestId('datatable-count')).toContainText('5000 行')

  // DOM 行数远小于 5000（虚拟化窗口 + overscan）
  const rendered = await table.locator('tbody tr:not(.vspacer)').count()
  expect(rendered).toBeGreaterThan(0)
  expect(rendered).toBeLessThan(200)

  // 滚动到底部：窗口移动，能看到靠后的行
  const scroll = page.getByTestId('datatable-scroll')
  await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
  await expect.poll(async () => table.locator('tbody tr:not(.vspacer)').first().getAttribute('data-testid'), { timeout: 5000 }).not.toBe('datarow-0')
  const firstId = await table.locator('tbody tr:not(.vspacer)').first().getAttribute('data-testid')
  const firstIdx = Number(firstId?.replace('datarow-', ''))
  expect(firstIdx).toBeGreaterThan(4000)
})
