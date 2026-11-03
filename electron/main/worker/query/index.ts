/**
 * 查询模块入口
 * 统一导出基础查询和高级分析函数
 */

// 基础查询
export {
  getAvailableYears,
  getMemberActivity,
  getHourlyActivity,
  getDailyActivity,
  getWeekdayActivity,
  getMonthlyActivity,
  getMessageTypeDistribution,
  getTimeRange,
  getMemberNameHistory,
  getAllSessions,
  getSession,
  // 成员管理
  getMembers,
  updateMemberAliases,
  deleteMember,
} from './basic'

// 高级分析
export {
  getRepeatAnalysis,
  getCatchphraseAnalysis,
  getNightOwlAnalysis,
  getDragonKingAnalysis,
  getDivingAnalysis,
  getCheckInAnalysis,
  getMonologueAnalysis,
  getMemeBattleAnalysis,
  getMentionAnalysis,
  getLaughAnalysis,
  getStickerAnalysis,
} from './advanced'

// 表情包分析类型
export type { StickerAnalysisResult, StickerItem, StickerMemberStat } from './advanced'

// 聊天记录查询
export {
  searchMessages,
  getMessageContext,
  getRecentMessages,
  getAllRecentMessages,
  getConversationBetween,
  getMessagesBefore,
  getMessagesAfter,
} from './messages'

// 聊天记录查询类型
export type { MessageResult, PaginatedMessages, MessagesWithTotal } from './messages'

// SQL 实验室
export { executeRawSQL, getSchema } from './sql'
export type { SQLResult, TableSchema } from './sql'
