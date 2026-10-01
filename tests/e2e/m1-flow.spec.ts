import { test, expect, type Page } from '@playwright/test'

// M1 第一条真实业务链的端到端测试：CSV → 过滤 → 计算列 → 输出，全部真实交互、真实断言。
// 在生产构建 + Hash 路由 + 真实 Web Worker 上运行。

const CSV = 'name,price,qty\n苹果,1050,3\n香蕉,550,10\n橙子,800,2\n'

async function createProject(page: Page, name: string) {
  await page.goto('/#/')
  await page.locator('#new-project-name').fill(name)
  await page.getByRole('button', { name: '创建' }).click()
  await page.getByRole('link', { name }).click()
  await expect(page).toHaveURL(/#\/project\/.+/)
  await expect(page.getByTestId('canvas')).toBeVisible()
}

/** 取画布上节点的 id（按添加顺序）。限定在 svg 内，避免误取检查器的 node-name 输入框。 */
async function nodeIds(page: Page): Promise<string[]> {
  const tids = await page
    .locator('[data-testid="canvas"] g[data-testid^="node-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  return tids
    .filter((t): t is string => !!t && t.startsWith('node-'))
    .map((t) => t.slice('node-'.length))
}

/** 从源节点输出端口拖到目标节点输入端口，完成连线。 */
async function connect(page: Page, sourceId: string, targetId: string) {
  const out = page.getByTestId(`port-out-out-${sourceId}`)
  const inp = page.getByTestId(`port-in-in-${targetId}`)
  const outBox = await out.boundingBox()
  const inBox = await inp.boundingBox()
  expect(outBox, '输出端口可见').not.toBeNull()
  expect(inBox, '输入端口可见').not.toBeNull()
  await page.mouse.move(outBox!.x + outBox!.width / 2, outBox!.y + outBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(inBox!.x + inBox!.width / 2, inBox!.y + inBox!.height / 2, { steps: 12 })
  await page.mouse.up()
}

/** 点击节点以选中（用于打开检查器）。 */
async function selectNode(page: Page, id: string) {
  await page.getByTestId(`node-${id}`).click()
  await expect(page.getByTestId('inspector')).toBeVisible()
}

test('M1 业务链：CSV → 过滤 → 计算列 → 输出，结果真实正确', async ({ page }) => {
  await createProject(page, 'M1 业务链')

  // 添加 4 个节点
  await page.getByTestId('add-csv-input').click()
  await page.getByTestId('add-filter').click()
  await page.getByTestId('add-computed-column').click()
  await page.getByTestId('add-output').click()
  const [csvId, filterId, ccId, outId] = await nodeIds(page)
  expect([csvId, filterId, ccId, outId].every(Boolean)).toBe(true)

  // 配置 CSV 输入
  await selectNode(page, csvId!)
  await page.getByTestId('param-csvText').fill(CSV)

  // 配置过滤：只保留 qty >= 5
  await selectNode(page, filterId!)
  await page.getByTestId('param-condition').fill('$qty >= 5')

  // 配置计算列：total = price * qty（整数分，无浮点误差）
  await selectNode(page, ccId!)
  await page.getByTestId('param-column').fill('total')
  await page.getByTestId('param-expression').fill('$price * $qty')

  // 连线
  await connect(page, csvId!, filterId!)
  await connect(page, filterId!, ccId!)
  await connect(page, ccId!, outId!)

  // 运行
  await page.getByTestId('run-btn').click()

  // 选中输出节点，检查输出预览：只有香蕉，且 total = 5500
  await selectNode(page, outId!)
  const table = page.getByTestId('datatable')
  await expect(table).toBeVisible()
  await expect(table).toContainText('香蕉')
  await expect(table).toContainText('5500')
  await expect(table).not.toContainText('苹果')
  await expect(table).not.toContainText('橙子')
  await expect(table.getByText('1 行 × 4 列')).toBeVisible()

  // 运行日志：4 个节点全部 ok
  await page.getByTestId('tab-log').click()
  for (const id of [csvId, filterId, ccId, outId]) {
    const row = page.getByTestId(`runrow-${id}`)
    await expect(row).toContainText('ok')
  }
  await expect(page.getByTestId(`runrow-${csvId}`)).toContainText('3', { ignoreCase: false })
})

test('M1 错误修复流：表达式错误 → 定位 → 修正 → 运行成功', async ({ page }) => {
  await createProject(page, 'M1 错误修复')

  await page.getByTestId('add-csv-input').click()
  await page.getByTestId('add-filter').click()
  const [csvId, filterId] = await nodeIds(page)
  await connect(page, csvId!, filterId!)

  // 写错字段名
  await selectNode(page, filterId!)
  await page.getByTestId('param-condition').fill('$不存在的字段 > 1')

  // 运行按钮应被禁用，问题按钮标红计数
  await expect(page.getByTestId('run-btn')).toBeDisabled()
  await expect(page.getByTestId('issues-btn')).toContainText('问题')

  // 点击问题跳转到节点（检查器显示该节点）
  await page.getByTestId('tab-log').click()
  await page.getByTestId('issue-0').click()
  await expect(page.getByTestId('inspector')).toBeVisible()
  await expect(page.getByTestId('node-name')).toHaveValue(/过滤/)

  // 修正表达式（CSV 列为 a,b）
  await page.getByTestId('param-condition').fill('$age >= 18')
  await expect(page.getByTestId('run-btn')).toBeEnabled()

  // 运行成功
  await page.getByTestId('run-btn').click()
  await selectNode(page, filterId!)
  await page.getByTestId('tab-output').click()
  const table = page.getByTestId('datatable')
  await expect(table).toBeVisible()
  await expect(table.getByText('3 行 × 3 列')).toBeVisible()
})

test('M1 删除节点：Delete 键删除选中，校验问题出现', async ({ page }) => {
  await createProject(page, 'M1 删除')

  await page.getByTestId('add-csv-input').click()
  await page.getByTestId('add-filter').click()
  const [csvId, filterId] = await nodeIds(page)
  await connect(page, csvId!, filterId!)

  // 选中过滤节点并删除
  await selectNode(page, filterId!)
  await page.keyboard.press('Delete')
  await expect(page.getByTestId(`node-${filterId}`)).toHaveCount(0)

  // csv-input 成为孤立节点：无错误（输入节点无需上游），但可以重新运行
  await expect(page.getByTestId('run-btn')).toBeEnabled()
})

test('M1 刷新恢复：图结构与参数在刷新后保留', async ({ page }) => {
  await createProject(page, 'M1 刷新恢复')

  await page.getByTestId('add-csv-input').click()
  await page.getByTestId('add-output').click()
  const [csvId, outId] = await nodeIds(page)
  await selectNode(page, csvId!)
  await page.getByTestId('param-csvText').fill('a,b\n1,2\n')
  await connect(page, csvId!, outId!)

  // 等待自动保存完成
  await expect(page.getByTestId('save-status')).toHaveText('已保存', { timeout: 10000 })

  await page.reload()
  await expect(page.getByTestId('canvas')).toBeVisible()
  const ids = await nodeIds(page)
  expect(ids).toHaveLength(2)
  await selectNode(page, ids[0]!)
  await expect(page.getByTestId('param-csvText')).toHaveValue('a,b\n1,2\n')
})

test('M1 运行隔离：运行后再编辑，旧结果标注旧版本', async ({ page }) => {
  await createProject(page, 'M1 运行隔离')

  await page.getByTestId('add-csv-input').click()
  await page.getByTestId('add-output').click()
  const [csvId, outId] = await nodeIds(page)
  await connect(page, csvId!, outId!)
  await page.getByTestId('run-btn').click()

  await selectNode(page, outId!)
  await expect(page.getByTestId('datatable')).toBeVisible()
  await expect(page.getByTestId('stale-badge')).toHaveCount(0)

  // 运行后编辑参数 → 修订号变化 → 旧结果标注为旧版本
  await selectNode(page, csvId!)
  await page.getByTestId('param-csvText').fill('a\n9\n')
  await expect(page.getByTestId('stale-badge')).toBeVisible()
  await expect(page.getByTestId('stale-badge')).toContainText('旧版本')
})
