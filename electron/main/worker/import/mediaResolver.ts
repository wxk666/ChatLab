/**
 * 导入媒体解析模块
 *
 * 场景：从导出文件夹导入时，JSON 里的表情/图片通常只保存相对路径
 * （如 `emoji/xxx.gif`、`FileStorage/Image/xxx.png`）。
 * 本模块负责：
 *   1. 在导入完成后扫描 EMOJI 消息，提取其中的相对路径
 *   2. 在导出文件夹根目录（含常见子目录）中定位真实文件
 *   3. 按文件内容 md5 复制到本地媒体缓存 `<ChatLab>/media/<sessionId>/`
 *   4. 将消息 content 改写为 `media:<md5>.<ext>`，渲染时通过
 *      `chatlab-media://` 协议读取，避免依赖原始文件夹位置
 */

import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import { MessageType } from '../../../../src/types/base'

/** 常见媒体子目录（微信导出结构里这些目录名较为固定） */
const COMMON_SUBDIRS = [
  '',
  'emoji',
  'emojis',
  'emoji_pkg',
  'emotion',
  'emotions',
  'sticker',
  'stickers',
  'images',
  'image',
  'img',
  'media',
  'thumb',
  'thumbs',
  'FileStorage',
  'FileStorage/Image',
  'FileStorage/Emoji',
  'FileStorage/Image/*',
]

/** 媒体文件扩展名 */
const MEDIA_EXT_RE = /\.(gif|png|jpe?g|webp|bmp|apng)$/i

/** 从内容中提取看起来像媒体相对路径的片段 */
const PATH_TOKEN_RE = /((?:[A-Za-z0-9_\-.]+\/)*[A-Za-z0-9_\-.\u4e00-\u9fa5@]+\.[A-Za-z0-9]{2,5})/g

export interface MediaResolveResult {
  scanned: number
  matched: number
  copied: number
  mediaDir: string
}

/**
 * 获取某会话的媒体缓存目录
 */
export function getMediaDir(dbDir: string, sessionId: string): string {
  return path.join(path.dirname(dbDir), 'media', sessionId)
}

/**
 * 从任意文本中提取候选媒体相对路径
 */
export function extractMediaPaths(content: string): string[] {
  const results = new Set<string>()
  let m: RegExpExecArray | null
  PATH_TOKEN_RE.lastIndex = 0
  while ((m = PATH_TOKEN_RE.exec(content)) !== null) {
    const token = m[1].replace(/^\.\//, '').replace(/\\/g, '/')
    if (!MEDIA_EXT_RE.test(token)) continue
    // 排除 http(s) 链接片段
    if (/^https?:/i.test(token)) continue
    results.add(token)
  }
  return [...results]
}

/**
 * 在导出文件夹中定位文件
 */
export function locateMediaFile(rootDir: string, relative: string): string | null {
  const normalized = relative.replace(/\\/g, '/').replace(/^\.?\//, '')
  const fileName = path.basename(normalized)

  // 1. 直接按相对路径拼接
  const direct = path.join(rootDir, normalized)
  if (isFile(direct)) return direct

  // 2. 常见子目录 + 原相对路径
  for (const sub of COMMON_SUBDIRS) {
    if (!sub) continue
    const candidate = path.join(rootDir, sub, normalized)
    if (isFile(candidate)) return candidate
  }

  // 3. 常见子目录 + 文件名
  for (const sub of COMMON_SUBDIRS) {
    const candidate = path.join(rootDir, sub, fileName)
    if (isFile(candidate)) return candidate
  }

  // 4. 递归兜底查找（限制深度，避免大目录扫描过慢）
  return findByFileName(rootDir, fileName, 4)
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * 按文件名递归查找（带深度限制与节点上限）
 */
function findByFileName(rootDir: string, fileName: string, maxDepth: number): string | null {
  let visited = 0
  const MAX_VISITED = 20000

  const walk = (dir: string, depth: number): string | null => {
    if (depth > maxDepth || visited > MAX_VISITED) return null
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      visited++
      if (visited > MAX_VISITED) return null
      const full = path.join(dir, entry.name)
      if (entry.isFile() && entry.name === fileName) return full
      if (entry.isDirectory()) {
        const found = walk(full, depth + 1)
        if (found) return found
      }
    }
    return null
  }

  return walk(rootDir, 0)
}

/**
 * 将文件复制进媒体缓存，返回缓存文件名（md5 + 扩展名）
 */
function copyToCache(sourcePath: string, mediaDir: string): string {
  const buffer = fs.readFileSync(sourcePath)
  const md5 = createHash('md5').update(buffer).digest('hex')
  const ext = (path.extname(sourcePath) || '.gif').toLowerCase()
  const storedName = `${md5}${ext}`
  const target = path.join(mediaDir, storedName)
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, buffer)
  }
  return storedName
}

/**
 * 解析并改写表情消息的媒体引用
 *
 * @param db 已打开的会话数据库（可写）
 * @param sessionId 会话 ID
 * @param dbDir 数据库目录（用于推导媒体缓存目录）
 * @param rootDir 导出文件夹根目录
 */
export function resolveStickerMedia(
  db: Database.Database,
  sessionId: string,
  dbDir: string,
  rootDir: string,
  onProgress?: (done: number, total: number) => void
): MediaResolveResult {
  const mediaDir = getMediaDir(dbDir, sessionId)
  const result: MediaResolveResult = { scanned: 0, matched: 0, copied: 0, mediaDir }

  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true })
  }

  const rows = db
    .prepare(`SELECT id, content FROM message WHERE type = ? AND content LIKE ?`)
    .all(MessageType.EMOJI, '%.gif%') as Array<{ id: number; content: string }>

  // 同时兼容 png/jpg 等扩展名的表情
  const rows2 = db
    .prepare(
      `SELECT id, content FROM message
       WHERE type = ? AND (
         content LIKE '%.png%' OR content LIKE '%.jpg%' OR content LIKE '%.jpeg%'
         OR content LIKE '%.webp%' OR content LIKE '%.bmp%'
       )`
    )
    .all(MessageType.EMOJI) as Array<{ id: number; content: string }>

  const allRows = [...rows, ...rows2]
  // 去重（同一条消息可能同时命中多个 LIKE）
  const uniqueRows = new Map<number, { id: number; content: string }>()
  for (const row of allRows) uniqueRows.set(row.id, row)

  const candidates = [...uniqueRows.values()]
  result.scanned = candidates.length

  if (candidates.length === 0) return result

  const update = db.prepare(`UPDATE message SET content = ? WHERE id = ?`)
  const copiedCache = new Map<string, string>() // sourcePath -> storedName

  const run = db.transaction((items: Array<{ id: number; content: string }>) => {
    let done = 0
    for (const item of items) {
      done++
      if (onProgress && done % 200 === 0) onProgress(done, items.length)

      const paths = extractMediaPaths(item.content)
      if (paths.length === 0) continue

      for (const rel of paths) {
        const real = locateMediaFile(rootDir, rel)
        if (!real) continue

        result.matched++
        let storedName = copiedCache.get(real)
        if (!storedName) {
          try {
            storedName = copyToCache(real, mediaDir)
            copiedCache.set(real, storedName)
            result.copied++
          } catch {
            continue
          }
        }
        update.run(`media:${storedName}`, item.id)
        break
      }
    }
  })

  run(candidates)
  return result
}
