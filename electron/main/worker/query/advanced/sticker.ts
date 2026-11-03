/**
 * 表情包分析模块
 *
 * 目标：
 * - 以 md5（或内容指纹）聚合表情包，统计每个表情被使用的次数
 * - 统计双方/各成员的表情包发送量、独立表情种类、表情占比
 * - 输出 Top 表情、双方共享/独有表情、时间趋势
 * - 额外统计文字型表情（如 [呲牙]、[旺柴]）的使用频次
 *
 * 数据来源：message 表中 type = 5（EMOJI）的消息，content 字段保存原始内容
 * 不同导出工具对表情内容的保存形式不同，这里统一做指纹提取：
 *   1. XML/JSON 中的 md5 字段（微信自定义表情包）
 *   2. cdnurl / url 中的 32 位十六进制串（微信 CDN 路径通常包含 md5）
 *   3. 形如 [xxx] 的文字表情描述
 *   4. 兜底：内容哈希
 */

import { createHash } from 'crypto'
import { openDatabase, buildTimeFilter, type TimeFilter } from '../../core'
import { MessageType } from '../../../../../src/types/base'

// ==================== 类型定义 ====================

export interface StickerMemberStat {
  memberId: number
  name: string
  stickerCount: number // 表情消息总数
  uniqueCount: number // 独立表情种类数
  totalMessages: number // 该成员总消息数
  ratio: number // 表情占其消息的百分比（保留两位小数）
  topLabel: string | null // 最常用表情
  topCount: number // 最常用表情次数
}

export interface StickerUsageByMember {
  memberId: number
  name: string
  count: number
}

export interface StickerItem {
  stickerId: string
  label: string
  previewUrl: string | null
  count: number
  byMember: StickerUsageByMember[]
}

export interface StickerAnalysisResult {
  totalStickers: number
  uniqueStickers: number
  totalMessages: number
  stickerRatio: number
  members: StickerMemberStat[]
  topStickers: StickerItem[]
  trend: Array<{ date: string; count: number }>
  sharedCount: number
  exclusive: Array<{ memberId: number; name: string; count: number }>
  textEmoji: Array<{ label: string; count: number }>
}

// ==================== 表情指纹提取 ====================

/** 微信内置的占位描述，不应被当成文字表情统计 */
const PLACEHOLDER_LABELS = new Set([
  '图片',
  '链接',
  '文件',
  '视频',
  '语音',
  '动画表情',
  '表情',
  '位置',
  '转账',
  '红包',
  '聊天记录',
  '小程序',
  '视频号',
  '音乐',
  '名片',
  '拍一拍',
  '系统消息',
  '未知消息',
])

/** XML / JSON 中的 md5 字段 */
const MD5_FIELD_RE = /["']?\bmd5\b["']?\s*[:=]\s*["']([0-9a-fA-F]{16,40})["']/i
/** cdnurl / url / thumburl 等地址属性 */
const URL_FIELD_RE = /["']?\b(?:cdnurl|cdnUrl|cdn_url|thumburl|thumbUrl|thumb_url|url|src)\b["']?\s*[:=]\s*["']([^"']{8,})["']/i
/** 任意位置的 32 位十六进制（微信 md5 长度） */
const BARE_MD5_RE = /\b([0-9a-f]{32})\b/i
/** 纯文字表情：[呲牙] */
const BRACKET_RE = /^\[([^[\]]{1,12})\]$/

interface StickerFingerprint {
  stickerId: string
  label: string
  previewUrl: string | null
  isTextEmoji: boolean
}

/**
 * 从一条表情消息的 content 中提取唯一指纹
 */
function extractFingerprint(content: string | null, sessionId: string): StickerFingerprint | null {
  if (!content) return null

  const raw = content.trim()
  if (!raw) return null

  // 0. 导入时已关联到本地媒体缓存：media:<md5>.<ext>
  const mediaMatch = raw.match(/^media:([A-Za-z0-9._-]+)$/)
  if (mediaMatch) {
    const fileName = mediaMatch[1]
    const md5 = fileName.replace(/\.[^.]+$/, '').toLowerCase()
    return {
      stickerId: md5,
      label: `表情 ${md5.slice(0, 8)}`,
      previewUrl: `chatlab-media://${encodeURIComponent(sessionId)}/${encodeURIComponent(fileName)}`,
      isTextEmoji: false,
    }
  }

  // 1. 直接是 [xxx] 形式的文字表情
  const bracketMatch = raw.match(BRACKET_RE)
  if (bracketMatch) {
    const label = bracketMatch[1]
    if (PLACEHOLDER_LABELS.has(label)) {
      // 只有"[动画表情]"这类占位符、无法知道具体是哪个表情 → 直接剔除，不参与任何统计
      return null
    }
    return {
      stickerId: `text:${label.toLowerCase()}`,
      label: `[${label}]`,
      previewUrl: null,
      isTextEmoji: true,
    }
  }

  // 2. XML / JSON 中的 md5
  const md5Match = raw.match(MD5_FIELD_RE)
  if (md5Match) {
    const md5 = md5Match[1].toLowerCase()
    return {
      stickerId: md5,
      label: `表情 ${md5.slice(0, 8)}`,
      previewUrl: extractUrl(raw),
      isTextEmoji: false,
    }
  }

  // 3. URL 中的 32 位串（微信 CDN 通常包含 md5）
  const url = extractUrl(raw)
  if (url) {
    const bare = url.match(BARE_MD5_RE)
    if (bare) {
      const md5 = bare[1].toLowerCase()
      return { stickerId: md5, label: `表情 ${md5.slice(0, 8)}`, previewUrl: url, isTextEmoji: false }
    }
  }

  // 4. 内容中裸露的 md5
  const bareMd5 = raw.match(BARE_MD5_RE)
  if (bareMd5) {
    const md5 = bareMd5[1].toLowerCase()
    return { stickerId: md5, label: `表情 ${md5.slice(0, 8)}`, previewUrl: url, isTextEmoji: false }
  }

  // 5. 兜底：内容哈希，保证同一条表情能被稳定聚合
  const hash = createHash('md5').update(raw).digest('hex')
  return {
    stickerId: `hash:${hash}`,
    label: raw.length <= 12 ? raw : `${raw.slice(0, 12)}…`,
    previewUrl: url,
    isTextEmoji: false,
  }
}

function extractUrl(raw: string): string | null {
  const m = raw.match(URL_FIELD_RE)
  if (!m) return null
  const value = m[1]
  if (!/^https?:\/\//i.test(value)) return null
  return value
}

/** 从普通文本中提取 [xxx] 形式的文字表情 */
const INLINE_BRACKET_RE = /\[([^[\]]{1,8})\]/g

function extractInlineTextEmoji(text: string, counter: Map<string, number>): void {
  let m: RegExpExecArray | null
  while ((m = INLINE_BRACKET_RE.exec(text)) !== null) {
    const label = m[1]
    if (PLACEHOLDER_LABELS.has(label)) continue
    // 过滤掉含标点/空白的"伪表情"
    if (/[\s，。！？、,.!?：:；;]/.test(label)) continue
    counter.set(label, (counter.get(label) || 0) + 1)
  }
}

// ==================== 主分析函数 ====================

export function getStickerAnalysis(sessionId: string, filter?: TimeFilter): StickerAnalysisResult {
  const empty: StickerAnalysisResult = {
    totalStickers: 0,
    uniqueStickers: 0,
    totalMessages: 0,
    stickerRatio: 0,
    members: [],
    topStickers: [],
    trend: [],
    sharedCount: 0,
    exclusive: [],
    textEmoji: [],
  }

  const db = openDatabase(sessionId)
  if (!db) return empty

  try {
    const { clause, params } = buildTimeFilter(filter)
    const where = clause || ''

    // ---------- 1. 成员总消息数 ----------
    const memberTotals = db
      .prepare(
        `
        SELECT msg.sender_id as memberId, COUNT(*) as total
        FROM message msg
        ${where}
        GROUP BY msg.sender_id
        `
      )
      .all(...params) as Array<{ memberId: number; total: number }>

    const totalMessages = memberTotals.reduce((sum, row) => sum + row.total, 0)
    const totalByMember = new Map<number, number>()
    for (const row of memberTotals) totalByMember.set(row.memberId, row.total)

    // ---------- 2. 表情消息明细 ----------
    let stickerWhere = where
    stickerWhere = stickerWhere ? `${stickerWhere} AND msg.type = ?` : ' WHERE msg.type = ?'
    const stickerParams = [...params, MessageType.EMOJI]

    const stickerMessages = db
      .prepare(
        `
        SELECT
          msg.sender_id as memberId,
          msg.ts as ts,
          msg.content as content,
          COALESCE(m.group_nickname, m.account_name, m.platform_id) as name
        FROM message msg
        JOIN member m ON msg.sender_id = m.id
        ${stickerWhere}
        ORDER BY msg.ts ASC
        `
      )
      .all(...stickerParams) as Array<{ memberId: number; ts: number; content: string | null; name: string }>

    const memberNames = new Map<number, string>()
    /** stickerId → 聚合结果 */
    const stickerMap = new Map<
      string,
      {
        label: string
        previewUrl: string | null
        count: number
        byMember: Map<number, number>
      }
    >()
    /** memberId → 该成员用过的 stickerId 集合 */
    const memberStickerSets = new Map<number, Set<string>>()
    /** memberId → 表情消息数 */
    const memberStickerCounts = new Map<number, number>()
    /** 日期 → 表情数 */
    const trendMap = new Map<string, number>()
    /** 参与统计的表情消息数（剔除无法识别的占位符后） */
    let countedStickers = 0

    for (const msg of stickerMessages) {
      const fp = extractFingerprint(msg.content, sessionId)
      if (!fp) continue
      countedStickers += 1

      memberNames.set(msg.memberId, msg.name)

      const entry = stickerMap.get(fp.stickerId) || {
        label: fp.label,
        previewUrl: fp.previewUrl,
        count: 0,
        byMember: new Map<number, number>(),
      }
      entry.count += 1
      entry.byMember.set(msg.memberId, (entry.byMember.get(msg.memberId) || 0) + 1)
      // 优先记录可预览地址
      if (!entry.previewUrl && fp.previewUrl) entry.previewUrl = fp.previewUrl
      stickerMap.set(fp.stickerId, entry)

      let set = memberStickerSets.get(msg.memberId)
      if (!set) {
        set = new Set<string>()
        memberStickerSets.set(msg.memberId, set)
      }
      set.add(fp.stickerId)

      memberStickerCounts.set(msg.memberId, (memberStickerCounts.get(msg.memberId) || 0) + 1)

      const date = formatDay(msg.ts)
      trendMap.set(date, (trendMap.get(date) || 0) + 1)
    }

    // ---------- 3. 成员维度统计 ----------
    const members: StickerMemberStat[] = []
    for (const [memberId, stickerCount] of memberStickerCounts) {
      const set = memberStickerSets.get(memberId)!
      const total = totalByMember.get(memberId) || 0

      // 找出该成员最常用的表情
      let topLabel: string | null = null
      let topCount = 0
      for (const stickerId of set) {
        const entry = stickerMap.get(stickerId)!
        const own = entry.byMember.get(memberId) || 0
        if (own > topCount) {
          topCount = own
          topLabel = entry.label
        }
      }

      members.push({
        memberId,
        name: memberNames.get(memberId) || `成员${memberId}`,
        stickerCount,
        uniqueCount: set.size,
        totalMessages: total,
        ratio: total > 0 ? Math.round((stickerCount / total) * 10000) / 100 : 0,
        topLabel,
        topCount,
      })
    }
    members.sort((a, b) => b.stickerCount - a.stickerCount)

    // ---------- 4. Top 表情 ----------
    const allStickers = [...stickerMap.entries()].map(([stickerId, entry]) => ({
      stickerId,
      label: entry.label,
      previewUrl: entry.previewUrl,
      count: entry.count,
      byMember: [...entry.byMember.entries()]
        .map(([memberId, count]) => ({
          memberId,
          name: memberNames.get(memberId) || `成员${memberId}`,
          count,
        }))
        .sort((a, b) => b.count - a.count),
    }))
    allStickers.sort((a, b) => b.count - a.count)

    // ---------- 5. 共享 / 独有 ----------
    let sharedCount = 0
    const exclusiveCounter = new Map<number, number>()
    for (const sticker of allStickers) {
      if (sticker.byMember.length >= 2) {
        sharedCount += 1
      } else if (sticker.byMember.length === 1) {
        const memberId = sticker.byMember[0].memberId
        exclusiveCounter.set(memberId, (exclusiveCounter.get(memberId) || 0) + 1)
      }
    }
    const exclusive = [...exclusiveCounter.entries()]
      .map(([memberId, count]) => ({
        memberId,
        name: memberNames.get(memberId) || `成员${memberId}`,
        count,
      }))
      .sort((a, b) => b.count - a.count)

    // ---------- 6. 时间趋势 ----------
    const trend = [...trendMap.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // ---------- 7. 文字表情（[呲牙] 等） ----------
    let textWhere = where
    textWhere = textWhere ? `${textWhere} AND msg.type = ?` : ' WHERE msg.type = ?'
    const textMessages = db
      .prepare(
        `
        SELECT msg.content as content
        FROM message msg
        ${textWhere}
        `
      )
      .all(...params, MessageType.TEXT) as Array<{ content: string | null }>

    const textEmojiCounter = new Map<string, number>()
    for (const row of textMessages) {
      if (row.content) extractInlineTextEmoji(row.content, textEmojiCounter)
    }
    const textEmoji = [...textEmojiCounter.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)

    const totalStickers = countedStickers
    return {
      totalStickers,
      uniqueStickers: stickerMap.size,
      totalMessages,
      stickerRatio: totalMessages > 0 ? Math.round((totalStickers / totalMessages) * 10000) / 100 : 0,
      members,
      topStickers: allStickers.slice(0, 30),
      trend,
      sharedCount,
      exclusive,
      textEmoji,
    }
  } finally {
    // 注意：db 来自 openDatabase 的缓存，不能关闭，否则后续查询拿到已关闭的连接
  }
}

/** 时间戳（秒）→ YYYY-MM-DD */
function formatDay(ts: number): string {
  const d = new Date(ts * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
