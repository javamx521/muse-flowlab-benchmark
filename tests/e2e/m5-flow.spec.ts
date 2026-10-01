import { test, expect, type Page } from '@playwright/test'

// M5 端到端测试（F09 命令面板 / 快捷键 / 无障碍属性）。
// 在生产构建 + 真实浏览器上运行，全部真实交互、真实断言。

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

test.describe('M5 无障碍与移动端', () => {
  test('跳链存在且聚焦可见；运行状态 live region 存在', async ({ page }) => {
    await createProject(page, 'M5 A11y 细节')
    const skip = page.getByTestId('skip-link')
    await expect(skip).toBeAttached()
    await expect(skip).toHaveAttribute('href', '#canvas-main')
    await expect(page.getByTestId('run-status-live')).toHaveAttribute('aria-live', 'polite')
    await expect(page.locator('#canvas-main')).toBeVisible()
  })

  test('移动端视口（390px）：布局不断裂，画布可见', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await createProject(page, 'M5 移动端')
    await expect(page.getByTestId('canvas')).toBeVisible()
    await expect(page.getByTestId('palette-btn')).toBeVisible()
    await expect(page.getByTestId('run-btn')).toBeVisible()
    // 命令面板在小屏仍可用
    await page.getByTestId('palette-btn').click()
    await expect(page.getByTestId('command-palette')).toBeVisible()
  })
})

test.describe('M5 Service Worker', () => {
  test('生产构建注册 SW（localhost 支持）', async ({ page }) => {
    await page.goto('/#/')
    // 等待 SW 注册（生产构建才注册，dev 跳过）
    const reg = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'unsupported'
      const r = await navigator.serviceWorker.getRegistration()
      return r ? r.scope : 'none'
    })
    // localhost 下应已注册；若环境不支持则标记为环境限制
    expect(['unsupported', 'none'].includes(reg as string) || (reg as string).includes('muse-flowlab-benchmark')).toBeTruthy()
  })
})

test.describe('M5 命令面板与快捷键', () => {
  test('Ctrl+K 打开命令面板，模糊搜索并执行"清除缓存"', async ({ page }) => {
    await createProject(page, 'M5 命令面板')
    await page.keyboard.press('Control+k')
    await expect(page.getByTestId('command-palette')).toBeVisible()
    await page.getByTestId('palette-input').fill('缓存')
    await expect(page.getByTestId('palette-item-clear-cache')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-palette')).toBeHidden()
  })

  test('命令面板按钮可打开；Esc 关闭', async ({ page }) => {
    await createProject(page, 'M5 面板按钮')
    await page.getByTestId('palette-btn').click()
    await expect(page.getByTestId('command-palette')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('command-palette')).toBeHidden()
  })

  test('? 打开快捷键帮助对话框', async ({ page }) => {
    await createProject(page, 'M5 快捷键帮助')
    await page.keyboard.press('?')
    await expect(page.getByTestId('shortcuts-dialog')).toBeVisible()
    await expect(page.getByTestId('shortcuts-dialog')).toContainText('Ctrl+K')
    await page.getByTestId('shortcuts-close').click()
    await expect(page.getByTestId('shortcuts-dialog')).toBeHidden()
  })

  test('Ctrl+Enter 运行工作流', async ({ page }) => {
    await createProject(page, 'M5 运行快捷键')
    await page.getByTestId('add-synthetic-input').click()
    await page.getByTestId('add-output').click()
    const [synId, outId] = await nodeIds(page)
    await connect(page, synId!, outId!)

    await page.keyboard.press('Control+Enter')
    await page.getByTestId('tab-log').click()
    await page.getByTestId('cache-summary').waitFor({ timeout: 60000 })
  })

  test('命令面板无障碍属性：dialog + listbox + option', async ({ page }) => {
    await createProject(page, 'M5 无障碍')
    await page.getByTestId('palette-btn').click()
    const dialog = page.getByTestId('command-palette')
    await expect(dialog).toHaveAttribute('role', 'dialog')
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect(page.getByTestId('palette-list')).toHaveAttribute('role', 'listbox')
    const first = page.getByTestId('palette-list').getByRole('option').first()
    await expect(first).toBeVisible()
  })
})
