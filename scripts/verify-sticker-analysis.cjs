/**
 * 表情包分析本地验证脚本（不进入生产代码）
 * 用法：node scripts/verify-sticker-analysis.cjs
 *
 * 1. 在临时目录创建一份符合 ChatLab schema 的会话数据库
 * 2. 灌入混合格式的表情消息（微信 XML md5 / [呲牙] / 无 md5 的自定义表情）
 * 3. 通过 dbWorker 调用 getStickerAnalysis，校验聚合结果
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { Worker } = require('worker_threads')
const Database = require('better-sqlite3')

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlab-sticker-'))
const sessionId = 'sticker_demo'
const dbPath = path.join(dbDir, `${sessionId}.db`)

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE meta (
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    type TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    group_id TEXT,
    group_avatar TEXT,
    owner_id TEXT,
    schema_version INTEGER DEFAULT 1
  );
  CREATE TABLE member (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform_id TEXT NOT NULL UNIQUE,
    account_name TEXT,
    group_nickname TEXT,
    aliases TEXT DEFAULT '[]',
    avatar TEXT
  );
  CREATE TABLE member_name_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    name_type TEXT NOT NULL,
    name TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER
  );
  CREATE TABLE message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    sender_account_name TEXT,
    sender_group_nickname TEXT,
    ts INTEGER NOT NULL,
    type INTEGER NOT NULL,
    content TEXT
  );
  CREATE INDEX idx_message_ts ON message(ts);
  CREATE INDEX idx_message_sender ON message(sender_id);
`)

db.prepare(`INSERT INTO meta (name, platform, type, imported_at) VALUES (?, ?, ?, ?)`).run(
  '测试会话',
  'weixin',
  'private',
  Math.floor(Date.now() / 1000)
)
db.prepare(`INSERT INTO member (platform_id, account_name) VALUES (?, ?)`).run('wxid_me', '小明')
db.prepare(`INSERT INTO member (platform_id, account_name) VALUES (?, ?)`).run('wxid_ta', '小红')

const insert = db.prepare(`INSERT INTO message (sender_id, ts, type, content) VALUES (?, ?, ?, ?)`)

// 基准时间：2026-06-01 起
const base = Math.floor(new Date('2026-06-01T10:00:00').getTime() / 1000)
let n = 0

/** 微信自定义表情包（带 md5 的 XML） */
const xmlSticker = (md5, cdn) =>
  `<msg><emoji md5="${md5}" cdnurl="${cdn}" type="1" /></msg>`

// 小明：3 种表情，共 6 次
insert.run(1, base + n++, 5, xmlSticker('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'http://cdn.example.com/a/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.gif'))
insert.run(1, base + n++, 5, xmlSticker('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ''))
insert.run(1, base + n++, 5, xmlSticker('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', ''))
insert.run(1, base + n++, 5, '[呲牙]')
insert.run(1, base + n++, 5, '[呲牙]')
insert.run(1, base + n++, 5, '[动画表情]') // 无法识别具体表情，归入 unknown

// 小红：2 种表情（含一种与小明共用），共 5 次
insert.run(2, base + n++, 5, xmlSticker('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ''))
insert.run(2, base + n++, 5, xmlSticker('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', ''))
insert.run(2, base + n++, 5, xmlSticker('cccccccccccccccccccccccccccccccc', ''))
insert.run(2, base + n++, 5, '[旺柴]')
insert.run(2, base + n++, 5, '[旺柴]')

// 普通文本消息（含文字表情）
for (let i = 0; i < 8; i++) {
  insert.run(1, base + n++, 0, i === 0 ? '今天好热啊[捂脸]' : '随便说点什么')
  insert.run(2, base + n++, 0, i === 0 ? '是啊[捂脸][流泪]' : '好的呀')
}
// 图片消息，用于验证只统计表情类型
insert.run(1, base + n++, 1, '[图片]')

db.close()

const worker = new Worker(path.join(__dirname, '..', 'out', 'main', 'worker', 'dbWorker.js'), {
  workerData: { dbDir },
})

let id = 0
worker.on('message', (msg) => {
  if (msg.id !== id) return
  if (!msg.success) {
    console.error('❌ 查询失败：', msg.error)
    process.exit(1)
  }
  const r = msg.result
  console.log('=== 表情包分析结果 ===')
  console.log('表情消息总数:', r.totalStickers)
  console.log('独立表情数  :', r.uniqueStickers)
  console.log('总消息数    :', r.totalMessages)
  console.log('表情占比    :', r.stickerRatio + '%')
  console.log('共享表情数  :', r.sharedCount)
  console.log('\n成员统计:')
  for (const m of r.members) {
    console.log(
      `  ${m.name}: 表情 ${m.stickerCount} / 种类 ${m.uniqueCount} / 占比 ${m.ratio}% / 最爱 ${m.topLabel} x${m.topCount}`
    )
  }
  console.log('\nTop 表情:')
  for (const s of r.topStickers) {
    console.log(
      `  ${s.label} (${s.stickerId.slice(0, 12)}) x${s.count} → ${s.byMember.map((b) => `${b.name}:${b.count}`).join(', ')}`
    )
  }
  console.log('\n独有表情:', r.exclusive.map((e) => `${e.name}:${e.count}`).join(', '))
  console.log('文字表情 Top:', r.textEmoji.slice(0, 5).map((e) => `[${e.label}]x${e.count}`).join(' '))
  console.log('趋势点数:', r.trend.length)

  // 断言
  const checks = [
    ['表情总数应为 11', r.totalStickers === 11],
    ['独立表情应为 6（3个md5 + 呲牙 + 旺柴 + unknown）', r.uniqueStickers === 6],
    ['共享表情应为 2（a、b 两人都用过）', r.sharedCount === 2],
    ['小红独有表情应为 2（c 和 [旺柴]）', r.exclusive.find((e) => e.name === '小红')?.count === 2],
    ['小明最常用表情应为 a（2 次）', r.members.find((m) => m.name === '小明')?.topCount === 2],
    ['文字表情应统计到 捂脸', r.textEmoji.some((e) => e.label === '捂脸')],
  ]
  let failed = 0
  console.log('\n=== 断言 ===')
  for (const [label, ok] of checks) {
    console.log(`${ok ? '✅' : '❌'} ${label}`)
    if (!ok) failed++
  }
  worker.terminate()
  fs.rmSync(dbDir, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
})

id = 1
worker.postMessage({ id, type: 'getStickerAnalysis', payload: { sessionId } })
