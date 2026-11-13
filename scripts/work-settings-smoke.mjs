import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'
const url=process.argv[2]
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox','--disable-crashpad','--disable-breakpad','--disable-gpu']})
const page=await browser.newPage({viewport:{width:1440,height:1000}})
const errors=[]; page.on('pageerror',e=>errors.push(e.message))
await page.goto(url,{waitUntil:'domcontentloaded'}); await page.waitForTimeout(2500)
const c=page.getByRole('button',{name:'继续'}); if(await c.count()){await c.first().click().catch(()=>{});await page.waitForTimeout(500)}
await page.keyboard.press('Escape'); await page.waitForTimeout(400)
const row=page.getByText(/\[Work\]/).first()
if(await row.count()){await row.click().catch(()=>{});await page.waitForTimeout(1000)}
const wb=page.getByRole('button',{name:'工作',exact:true}).first()
if(await wb.count()){await wb.click().catch(()=>{});await page.waitForTimeout(1000)}
const panel=await page.locator('body').innerText()
const hasTaskPanel=panel.includes('当前任务')&&!panel.includes('当前会话还不是工作任务')
await page.keyboard.press('Escape'); await page.waitForTimeout(300)
await page.getByRole('button',{name:'账号菜单'}).first().click(); await page.waitForTimeout(400)
await page.getByText(/^设置/).first().click(); await page.waitForTimeout(800)
await page.getByRole('button',{name:'飞书',exact:true}).first().click(); await page.waitForTimeout(700)
const settings=await page.locator('body').innerText()
await mkdir('docs/screenshots',{recursive:true})
await page.screenshot({path:'docs/screenshots/redesign-settings.png',fullPage:true})
console.log(JSON.stringify({
 hasTaskPanel,
 hasTabs: settings.includes('连接')&&settings.includes('偏好')&&settings.includes('工作数据'),
 hasConnectors: settings.includes('连接器'),
 errors,
 excerpt: settings.slice(-400),
},null,2))
await browser.close()
