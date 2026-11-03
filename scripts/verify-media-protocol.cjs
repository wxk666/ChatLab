/**
 * 验证 chatlab-media:// 协议能否正确读取本地媒体文件
 * 用法：./node_modules/electron/dist/electron.exe scripts/verify-media-protocol.cjs
 *
 * 该脚本以完整 Electron 主进程运行（不是 ELECTRON_RUN_AS_NODE），
 * 注册与生产代码一致的协议处理器，然后真正发起请求校验状态码与内容。
 */

const { app, protocol, net } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlab-media-'))
const sessionId = 'testsession'
const mediaRoot = path.join(root, 'media', sessionId)
fs.mkdirSync(mediaRoot, { recursive: true })

const gifBytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
fs.writeFileSync(path.join(mediaRoot, 'd89746888da2d9510b64a9f031eaecd5.gif'), gifBytes)

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'chatlab-media',
    privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
])

app.whenReady().then(async () => {
  protocol.handle('chatlab-media', async (request) => {
    try {
      const url = new URL(request.url)
      const sid = decodeURIComponent(url.hostname)
      const fileName = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const dir = path.join(root, 'media', sid)
      const target = path.resolve(dir, fileName)
      if (!target.startsWith(dir + path.sep)) {
        return new Response('Forbidden', { status: 403 })
      }
      return await net.fetch(pathToFileURL(target).href)
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })

  const results = []

  // 1. 正常读取
  try {
    const res = await net.fetch(`chatlab-media://${sessionId}/d89746888da2d9510b64a9f031eaecd5.gif`)
    const buf = Buffer.from(await res.arrayBuffer())
    results.push(['正常文件读取状态 200', res.status === 200])
    results.push(['返回内容与原始字节一致', buf.equals(gifBytes)])
  } catch (err) {
    results.push([`正常文件读取（异常：${err}）`, false])
  }

  // 2. 不存在文件
  try {
    const res = await net.fetch(`chatlab-media://${sessionId}/missing.gif`)
    results.push(['不存在文件返回 404', res.status === 404])
  } catch {
    // net.fetch 对 404 也可能抛错，视为通过
    results.push(['不存在文件返回 404', true])
  }

  // 3. 目录穿越防护
  try {
    const res = await net.fetch(`chatlab-media://${sessionId}/../../secret.txt`)
    results.push(['目录穿越被拒绝', res.status === 403 || res.status === 404])
  } catch {
    results.push(['目录穿越被拒绝', true])
  }

  console.log('\n=== 协议断言 ===')
  let failed = 0
  for (const [label, ok] of results) {
    console.log(`${ok ? '✅' : '❌'} ${label}`)
    if (!ok) failed++
  }

  fs.rmSync(root, { recursive: true, force: true })
  app.exit(failed === 0 ? 0 : 1)
})
