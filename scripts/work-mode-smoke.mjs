import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'
const url = process.argv[2]
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox','--disable-crashpad','--disable-breakpad','--disable-gpu'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
const cont = page.getByRole('button', { name: '继续' })
if (await cont.count()) { await cont.first().click().catch(()=>{}); await page.waitForTimeout(500) }
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
const chip = page.getByText('工作模式', { exact: false }).first()
const hasChip = (await chip.count()) > 0
if (hasChip) { await chip.click().catch(()=>{}); await page.waitForTimeout(1200) }
const bodyAfter = await page.locator('body').innerText()
const workButton = page.getByRole('button', { name: '工作', exact: true }).first()
const hasHeaderButton = (await workButton.count()) > 0
if (hasHeaderButton) { await workButton.click().catch(()=>{}); await page.waitForTimeout(800) }
const bodyPanel = await page.locator('body').innerText()
await mkdir('docs/screenshots', { recursive: true })
await page.screenshot({ path: 'docs/screenshots/redesign-work-mode.png', fullPage: true })
console.log(JSON.stringify({
  hasChip,
  hasHeaderButton,
  hasWorkTitle: bodyAfter.includes('[Work]') || bodyAfter.includes('工作任务'),
  hasPanelTabs: bodyPanel.includes('当前任务') && bodyPanel.includes('成果库') && bodyPanel.includes('定时'),
  hasOldWorkbench: bodyPanel.includes('DSH WORK'),
  errors,
  excerpt: bodyAfter.slice(0, 300),
}, null, 2))
await browser.close()
