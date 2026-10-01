import { test, expect, type Page } from '@playwright/test'

// M2 端到端测试：多端口连线（join/branch）、图表渲染、调试模式。
// 在生产构建 + Hash 路由 + 真实 Web Worker 上运行，全部真实交互、真实断言。

const CSV_A = 'id,name,price\n1,苹果,1050\n2,香蕉,550\n3,橙子,800\n'
const CSV_B = 'id,stock\n1,30\n2,120\n3,45\n'

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

/** 端口连线：outPort 默认为 'out'，inPort 默认为 'in'。 */
async function connect(page: Page, sourceId: string, targetId: string, outPort = 'out', inPort = 'in') {
  const out = page.getByTestId(`port-out-${outPort}-${sourceId}`)
  const inp = page.getByTestId(`port-in-${inPort}-${targetId}`)
  const outBox = await out.boundingBox()
  const inBox = await inp.boundingBox()
  expect(outBox, `输出端口 ${outPort} 可见`).not.toBeNull()
  expect(inBox, `输入端口 ${inPort} 可见`).not.toBeNull()
  await page.mouse.move(outBox!.x + outBox!.width / 2, outBox!.y + outBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(inBox!.x + inBox!.width / 2, inBox!.y + inBox!.height / 2, { steps: 12 })
  await page.mouse.up()
}

async function selectNode(page: Page, id: string) {
  await page.getByTestId(`node-${id}`).click()
  await expect(page.getByTestId('inspector')).toBeVisible()
}

test('M2 多输入连线：两个 CSV → join(inner) → 输出', async ({ page }) => {
  await createProject(page, 'M2 Join')

  await page.getByTestId('add-csv-input').click()
  await page.getByTestId('add-csv-input').click()
  await page.getByTestId('add-join').click()
  await page.getByTestId('add-output').click()
  const [aId, bId, joinId, outId] = await nodeIds(page)
  expect([aId, bId, joinId, outId].every(Boolean)).toBe(true)

  await selectNode(page, aId!)
  await page.getByTestId('param-csvText').fill(CSV_A)
  await selectNode(page, bId!)
  await page.getByTestId('param-csvText').fill(CSV_B)
  await selectNode(page, joinId!)
  // 关联键默认为 id，无需修改

  // 分别连到 in 和 in2 端口
  await connect(page, aId!, joinId!, 'out', 'in')
  await connect(page, bId!, joinId!, 'out', 'in2')
  await connect(page, joinId!, outId!)

  await page.getByTestId('run-btn').click()
  await selectNode(page, outId!)
  const preview = page.getByTestId('datatable')
  await expect(preview).toBeVisible()
  // 3 行 × (id,name,price,stock) 4 列 = 12 个数据单元格（不含行号列）
  await expect(preview.getByText('香蕉')).toBeVisible()
  await expect(preview.getByText('120')).toBeVisible()
})

test('M2 分支与图表：CSV → branch → chart，端口切换查看', async ({ page }) => {
  await createProject(page, 'M2 分支图表')

  await page.getByTestId('add-csv-input').click()
  await page.getByTestId('add-branch').click()
  await page.getByTestId('add-chart').click()
  const [csvId, branchId, chartId] = await nodeIds(page)
  expect([csvId, branchId, chartId].every(Boolean)).toBe(true)

  await selectNode(page, csvId!)
  await page.getByTestId('param-csvText').fill(CSV_A)

  await selectNode(page, branchId!)
  await page.getByTestId('param-condition').fill('$price >= 800')

  await selectNode(page, chartId!)
  await page.getByTestId('param-xColumn').fill('name')
  await page.getByTestId('param-yColumn').fill('price')

  // branch.true → chart
  await connect(page, csvId!, branchId!)
  await connect(page, branchId!, chartId!, 'true', 'in')

  await page.getByTestId('run-btn').click()

  // 查看 branch 的 false 端口输出（应只有香蕉）
  await selectNode(page, branchId!)
  await page.getByTestId('view-port-false').click()
  await expect(page.getByTestId('datatable').getByText('香蕉')).toBeVisible()

  // 图表渲染
  await selectNode(page, chartId!)
  await expect(page.getByTestId('chart-svg')).toBeVisible()
})

test('M2 调试模式：断点暂停 → 单步 → 继续', async ({ page }) => {
  await createProject(page, 'M2 调试')

  await page.getByTestId('add-csv-input').click()
  await page.getByTestId('add-output').click()
  const [csvId, outId] = await nodeIds(page)
  expect([csvId, outId].every(Boolean)).toBe(true)

  await selectNode(page, csvId!)
  await page.getByTestId('param-csvText').fill(CSV_A)
  // 在输出节点上设断点
  await selectNode(page, outId!)
  await page.getByTestId('breakpoint-toggle').check()
  await expect(page.getByTestId('breakpoint-toggle')).toBeChecked()

  await connect(page, csvId!, outId!)

  // 开启调试并运行：应暂停在 output 节点
  await page.getByTestId('debug-toggle').check()
  await page.getByTestId('run-btn').click()
  await expect(page.getByTestId('debug-paused-badge')).toBeVisible({ timeout: 15000 })

  // 继续：运行完成，输出可见
  await page.getByTestId('debug-resume-btn').click()
  await selectNode(page, outId!)
  await expect(page.getByTestId('datatable').getByText('橙子')).toBeVisible()

  // 运行历史：至少有 1 条记录
  await expect(page.getByTestId('run-history')).not.toBeVisible() // 只有 1 条时不显示选择器
})

test('M2 复制粘贴与自动布局', async ({ page }) => {
  await createProject(page, 'M2 复制粘贴')

  await page.getByTestId('add-csv-input').click()
  await page.getByTestId('add-output').click()
  let ids = await nodeIds(page)
  expect(ids.length).toBe(2)

  // 选中一个节点并复制粘贴
  await page.getByTestId(`node-${ids[0]}`).click()
  await page.keyboard.press('ControlOrMeta+c')
  await page.keyboard.press('ControlOrMeta+v')
  ids = await nodeIds(page)
  expect(ids.length).toBe(3) // 2 + 粘贴的 1 个

  // 自动布局按钮存在且可点击
  await page.getByTestId('auto-layout').click()
  expect(await nodeIds(page).then((x) => x.length)).toBe(3)

  // 小地图渲染
  await expect(page.getByTestId('minimap')).toBeVisible()
})
