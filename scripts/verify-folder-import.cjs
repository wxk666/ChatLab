/**
 * 文件夹导入 + 表情包媒体解析 端到端验证
 * 用法：ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/verify-folder-import.cjs
 *
 * 1. 构造一个 echotrace 格式的导出文件夹（JSON + emoji 图片）
 * 2. 通过 dbWorker 执行 streamImport（带 mediaRoot）
 * 3. 校验：媒体文件被复制到 media/<sessionId>/，消息 content 改写为 media:xxx
 * 4. 调用 getStickerAnalysis，校验 previewUrl 指向 chatlab-media://
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { Worker } = require('worker_threads')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlab-folder-'))
const dbDir = path.join(root, 'databases')
fs.mkdirSync(dbDir, { recursive: true })

// 1x1 GIF 与 PNG 的最小字节
const gifBytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

fs.mkdirSync(path.join(root, 'emoji'), { recursive: true })
fs.mkdirSync(path.join(root, 'FileStorage', 'Emoji'), { recursive: true })
fs.writeFileSync(path.join(root, 'emoji', 'sticker-a.gif'), gifBytes)
fs.writeFileSync(path.join(root, 'FileStorage', 'Emoji', 'sticker-b.png'), pngBytes)

const t0 = Math.floor(new Date('2026-05-01T10:00:00').getTime() / 1000)

const chat = {
  session: {
    wxid: 'wxid_ta',
    nickname: '小红',
    remark: '小红',
    displayName: '小红',
    type: '私聊',
    lastTimestamp: t0 + 10,
    messageCount: 6,
  },
  avatars: {},
  messages: [
    {
      localId: 1,
      createTime: t0,
      formattedTime: '2026-05-01 10:00:00',
      type: '动画表情',
      localType: 47,
      content: 'emoji/sticker-a.gif',
      isSend: 1,
      senderUsername: 'wxid_me',
      senderDisplayName: '小明',
      senderAvatarKey: 'wxid_me',
      source: '',
    },
    {
      localId: 2,
      createTime: t0 + 1,
      formattedTime: '2026-05-01 10:00:01',
      type: '动画表情',
      localType: 47,
      content: 'FileStorage/Emoji/sticker-b.png',
      isSend: 0,
      senderUsername: 'wxid_ta',
      senderDisplayName: '小红',
      senderAvatarKey: 'wxid_ta',
      source: '',
    },
    {
      localId: 3,
      createTime: t0 + 2,
      formattedTime: '2026-05-01 10:00:02',
      type: '动画表情',
      localType: 47,
      content: 'emoji/sticker-a.gif',
      isSend: 0,
      senderUsername: 'wxid_ta',
      senderDisplayName: '小红',
      senderAvatarKey: 'wxid_ta',
      source: '',
    },
    {
      localId: 4,
      createTime: t0 + 3,
      formattedTime: '2026-05-01 10:00:03',
      type: '文本消息',
      localType: 1,
      content: '早上好[呲牙]',
      isSend: 1,
      senderUsername: 'wxid_me',
      senderDisplayName: '小明',
      senderAvatarKey: 'wxid_me',
      source: '',
    },
    {
      localId: 5,
      createTime: t0 + 4,
      formattedTime: '2026-05-01 10:00:04',
      type: '文本消息',
      localType: 1,
      content: '早[呲牙]',
      isSend: 0,
      senderUsername: 'wxid_ta',
      senderDisplayName: '小红',
      senderAvatarKey: 'wxid_ta',
      source: '',
    },
    {
      localId: 6,
      createTime: t0 + 5,
      formattedTime: '2026-05-01 10:00:05',
      type: '动画表情',
      localType: 47,
      content: 'emoji/not-exist.gif',
      isSend: 1,
      senderUsername: 'wxid_me',
      senderDisplayName: '小明',
      senderAvatarKey: 'wxid_me',
      source: '',
    },
  ],
}

const jsonPath = path.join(root, 'chat.json')
fs.writeFileSync(jsonPath, JSON.stringify(chat, null, 2), 'utf-8')

const worker = new Worker(path.join(__dirname, '..', 'out', 'main', 'worker', 'dbWorker.js'), {
  workerData: { dbDir },
})

let msgId = 0
const pending = new Map()

function call(type, payload) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, type, payload })
  })
}

worker.on('message', (msg) => {
  // 忽略进度消息
  if (msg.type === 'progress') return
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  if (msg.success) p.resolve(msg.result)
  else p.reject(new Error(msg.error))
})

async function main() {
  console.log('导出文件夹:', root)

  // 1. 导入（带 mediaRoot）
  const importResult = await call('streamImport', { filePath: jsonPath, mediaRoot: root })
  console.log('导入结果:', importResult)
  if (!importResult.success) throw new Error(`导入失败: ${importResult.error}`)

  const sessionId = importResult.sessionId

  // 2. 检查媒体缓存
  const mediaDir = path.join(root, 'media', sessionId)
  const mediaFiles = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : []
  console.log('媒体缓存目录:', mediaDir)
  console.log('缓存文件:', mediaFiles)

  // 3. 检查消息 content 是否被改写
  const Database = require('better-sqlite3')
  const db = new Database(path.join(dbDir, `${sessionId}.db`), { readonly: true })
  const rows = db.prepare('SELECT type, content FROM message ORDER BY ts ASC').all()
  db.close()
  console.log('消息内容:')
  for (const row of rows) console.log(`  type=${row.type} content=${row.content}`)

  // 4. 表情包分析
  const sticker = await call('getStickerAnalysis', { sessionId })
  console.log('\n表情包分析:')
  console.log('  表情总数:', sticker.totalStickers, '独立表情:', sticker.uniqueStickers)
  for (const s of sticker.topStickers) {
    console.log(`  ${s.label} x${s.count} preview=${s.previewUrl || '(无)'}`)
  }

  const checks = [
    ['导入成功', importResult.success === true],
    ['媒体缓存有 2 个文件', mediaFiles.length === 2],
    ['媒体文件已改写为 media: 前缀', rows.some((r) => String(r.content || '').startsWith('media:'))],
    ['不存在的表情文件保持原内容', rows.some((r) => r.content === 'emoji/not-exist.gif')],
    ['表情总数为 4', sticker.totalStickers === 4],
    ['真实表情的 previewUrl 使用 chatlab-media 协议', sticker.topStickers.some((s) => s.previewUrl && s.previewUrl.startsWith('chatlab-media://'))],
    ['未解析的表情仍有条目', sticker.topStickers.some((s) => !s.previewUrl)],
  ]

  console.log('\n=== 断言 ===')
  let failed = 0
  for (const [label, ok] of checks) {
    console.log(`${ok ? '✅' : '❌'} ${label}`)
    if (!ok) failed++
  }

  worker.terminate()
  fs.rmSync(root, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('❌ 测试异常:', err)
  worker.terminate()
  process.exit(1)
})
