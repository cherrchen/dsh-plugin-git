import { expect, test, type Page } from '@playwright/test'

async function openGitLab(page: Page, scenario = 'gitlab', lang = 'en') {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto(`/?scenario=${scenario}&lang=${lang}`)
  await page.getByRole('button', { name: /Fixture merge request/ }).click()
  await expect(page.getByRole('heading', { name: '#7 Fixture merge request' })).toBeVisible()
  await expect(page.getByRole('button', { name: lang === 'en' ? 'Checkout verified PR head' : '检出已核验的 PR 提交' })).toBeEnabled()
}
test('keeps GitLab copy and both authentication methods together with notification coverage in the dialog', async ({ page }) => {
  for (const lang of ['en', 'zh']) {
    await openGitLab(page, 'gitlab', lang)
    const coverage = lang === 'en' ? 'Notifications cover review-requested to-dos and state changes of your loaded merge requests. Changes-requested notifications are unavailable.' : '通知仅覆盖审阅请求待办及已加载的本人合并请求状态变化；修改请求通知不可用。'
    await expect(page.getByText(coverage)).toHaveCount(0)
    const title = lang === 'en' ? 'Platform authentication' : '平台认证'
    await page.getByRole('button', { name: title, exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: title })
    await expect(dialog.getByText(lang === 'en' ? 'Connected to GitLab' : '已连接 GitLab', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('radio', { name: lang === 'en' ? 'GitLab CLI (glab)' : 'GitLab CLI（glab）' })).toBeVisible()
    await expect(dialog.getByRole('radio', { name: lang === 'en' ? 'GitLab OAuth (device login)' : 'GitLab OAuth（设备码登录）' })).toBeDisabled()
    await expect(dialog.getByText(coverage)).toBeVisible()
    expect(await dialog.innerText()).not.toContain('GitHub')
    await page.screenshot({ path: test.info().outputPath(`gitlab-auth-${lang}.png`), animations: 'disabled' })
  }
})
test('browses a scoped GitLab merge request and posts one comment with an isolated Host', async ({ page }) => {
  const replies: Promise<string>[] = []
  page.on('response', response => { if (response.url().endsWith('/__test/rpc')) replies.push(response.text().catch(() => '')) })
  await openGitLab(page)
  await expect(page.getByText('Safe', { exact: true })).toBeVisible()
  await expect(page.getByText('Current approvals')).toBeVisible()
  await page.getByLabel('Comment / description').fill('Isolated comment')
  await page.getByRole('button', { name: 'Post comment', exact: true }).click()
  await expect(page.getByText('Action result: Succeeded')).toBeVisible()
  const id = await page.getByRole('status', { name: 'Fixture ID' }).textContent()
  const info = await page.request.post('/__test/inspect', { data: { id } }).then(response => response.json())
  expect(info.calls.filter((call: string) => call === 'gitlab:POST:/gitlab/api/v4/projects/42/merge_requests/7/notes')).toHaveLength(1)
  expect((await Promise.all(replies)).join('\n')).not.toContain('e2e-sentinel-')
  expect(await page.locator('body').innerText()).not.toContain('e2e-sentinel-')
})
test('keeps an unknown approval blocked until the comment and current approval are refreshed and inspected', async ({ page }) => {
  await openGitLab(page, 'gitlab-approval-unknown', 'zh')
  await page.getByLabel('评论／描述').fill('只发送一次')
  await page.getByRole('button', { name: '批准', exact: true }).click()
  await expect(page.getByText('评论已发送；核对审批时不要再次发送该评论。')).toBeVisible()
  await expect(page.getByRole('button', { name: '批准', exact: true })).toBeDisabled()
  const id = await page.getByRole('status', { name: 'Fixture ID' }).textContent()
  await page.getByRole('button', { name: '刷新', exact: true }).last().click()
  await expect(page.locator('article').filter({ hasText: '只发送一次' })).toBeVisible()
  await page.getByRole('button', { name: '我已核对刷新后的结果' }).click()
  await expect(page.getByRole('button', { name: '批准', exact: true })).toBeEnabled()
  const info = await page.request.post('/__test/inspect', { data: { id } }).then(response => response.json())
  expect(info.calls.filter((call: string) => call === 'gitlab:POST:/gitlab/api/v4/projects/42/merge_requests/7/notes')).toHaveLength(1)
  expect(info.calls.filter((call: string) => call === 'gitlab:POST:/gitlab/api/v4/projects/42/merge_requests/7/approve')).toHaveLength(1)
})
test('shows scoped review and local-push suggestions without writing todo state', async ({ page }) => {
  await openGitLab(page)
  await page.getByRole('button', { name: 'Simulate local push event' }).click()
  await expect(page.getByText('Create a merge request from a pushed branch', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Run notification fixture' }).click()
  await expect(page.getByText('Review requested · Fixture review')).toBeVisible()
  const id = await page.getByRole('status', { name: 'Fixture ID' }).textContent()
  const info = await page.request.post('/__test/inspect', { data: { id } }).then(response => response.json())
  expect(info.calls.some((call: string) => call.includes('/todos/mark_as_done'))).toBe(false)
  expect(info.calls.filter((call: string) => call === 'gitlab:GET:/gitlab/api/v4/todos')).toHaveLength(1)
})
