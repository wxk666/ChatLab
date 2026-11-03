<script setup lang="ts">
/**
 * 表情包分析 Tab
 *
 * 能力：
 * - 按 md5 / 内容指纹聚合表情，统计使用次数
 * - 双方（各成员）表情发送量、独立表情种类、表情占比对比
 * - 热门表情 Top 榜，含双方使用分布
 * - 表情使用趋势、共享/独有表情、文字表情（[呲牙] 等）频次
 */
import { computed, ref, watch } from 'vue'
import type { StickerAnalysis } from '@/types/analysis'
import { BarChart, LineChart } from '@/components/charts'
import type { BarChartData, LineChartData } from '@/components/charts'
import { SectionCard, StatCard, LoadingState, EmptyState } from '@/components/UI'

interface TimeFilter {
  startTs?: number
  endTs?: number
}

const props = defineProps<{
  sessionId: string
  timeFilter?: TimeFilter
}>()

const analysis = ref<StickerAnalysis | null>(null)
const isLoading = ref(false)
const loadError = ref<string | null>(null)

async function loadData() {
  if (!props.sessionId) return
  isLoading.value = true
  loadError.value = null
  try {
    analysis.value = await window.chatApi.getStickerAnalysis(props.sessionId, props.timeFilter)
  } catch (error) {
    console.error('加载表情包分析失败:', error)
    loadError.value = '表情包分析加载失败'
  } finally {
    isLoading.value = false
  }
}

watch(() => [props.sessionId, props.timeFilter], loadData, { immediate: true, deep: true })

const hasData = computed(() => !!analysis.value && analysis.value.totalStickers > 0)

/** 成员表情发送量对比 */
const memberBarData = computed<BarChartData>(() => {
  if (!analysis.value) return { labels: [], values: [] }
  return {
    labels: analysis.value.members.map((m) => m.name),
    values: analysis.value.members.map((m) => m.stickerCount),
  }
})

/** 独立表情种类对比 */
const uniqueBarData = computed<BarChartData>(() => {
  if (!analysis.value) return { labels: [], values: [] }
  return {
    labels: analysis.value.members.map((m) => m.name),
    values: analysis.value.members.map((m) => m.uniqueCount),
  }
})

/** 按天趋势（点位过多时按月聚合，保持图表可读） */
const trendData = computed<LineChartData>(() => {
  const trend = analysis.value?.trend || []
  if (trend.length <= 90) {
    return { labels: trend.map((t) => t.date.slice(5)), values: trend.map((t) => t.count) }
  }
  const monthMap = new Map<string, number>()
  for (const item of trend) {
    const month = item.date.slice(0, 7)
    monthMap.set(month, (monthMap.get(month) || 0) + item.count)
  }
  const entries = [...monthMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  return { labels: entries.map(([month]) => month), values: entries.map(([, count]) => count) }
})

const trendIsMonthly = computed(() => (analysis.value?.trend.length || 0) > 90)

/** 共享 / 独有比例 */
const uniquenessText = computed(() => {
  if (!analysis.value || analysis.value.uniqueStickers === 0) return ''
  const rate = Math.round((analysis.value.sharedCount / analysis.value.uniqueStickers) * 100)
  return `双方共用的表情占全部独立表情的 ${rate}%`
})

const topStickers = computed(() => analysis.value?.topStickers.slice(0, 12) || [])
const maxStickerCount = computed(() => Math.max(1, ...topStickers.value.map((s) => s.count)))

function barWidth(count: number): string {
  return `${Math.max(4, Math.round((count / maxStickerCount.value) * 100))}%`
}

/** 热门表情里各成员的使用文案，例如「小明 12 · 小红 8」 */
function memberSplit(item: { byMember: Array<{ name: string; count: number }> }): string {
  return item.byMember.map((m) => `${m.name} ${m.count}`).join(' · ')
}

const textEmoji = computed(() => analysis.value?.textEmoji.slice(0, 20) || [])
const maxTextEmojiCount = computed(() => Math.max(1, ...textEmoji.value.map((e) => e.count)))
</script>

<template>
  <div class="main-content space-y-6 p-6">
    <LoadingState v-if="isLoading" text="正在解析表情包..." />

    <EmptyState
      v-else-if="loadError"
      :text="loadError"
      icon="⚠️"
      padding="lg"
    />

    <EmptyState
      v-else-if="!hasData"
      text="这段时间里还没有表情包消息，换个年份试试？"
      icon="🙂"
      padding="lg"
    />

    <template v-else-if="analysis">
      <!-- 总览指标 -->
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="表情消息总数"
          :value="analysis.totalStickers.toLocaleString()"
          icon="😀"
          icon-bg="pink"
          value-color="pink"
          :subtext="`占全部消息 ${analysis.stickerRatio}%`"
        />
        <StatCard
          label="独立表情数"
          :value="analysis.uniqueStickers.toLocaleString()"
          icon="🎭"
          icon-bg="amber"
          value-color="amber"
          :subtext="uniquenessText"
        />
        <StatCard
          label="双方共用表情"
          :value="analysis.sharedCount.toLocaleString()"
          icon="🤝"
          icon-bg="blue"
          value-color="blue"
          subtext="两人都用过的表情"
        />
        <StatCard
          label="表情冠军"
          :value="analysis.members[0]?.name || '-'"
          icon="🏆"
          icon-bg="green"
          value-color="green"
          :subtext="`${analysis.members[0]?.stickerCount.toLocaleString() || 0} 个表情`"
        />
      </div>

      <!-- 双方对比 -->
      <SectionCard title="双方表情频次对比" description="谁更爱用表情包，一目了然">
        <div class="grid gap-6 p-5 lg:grid-cols-2">
          <div>
            <p class="mb-3 text-sm font-medium text-gray-600 dark:text-gray-400">表情发送量</p>
            <BarChart :data="memberBarData" :height="200" />
          </div>
          <div>
            <p class="mb-3 text-sm font-medium text-gray-600 dark:text-gray-400">独立表情种类</p>
            <BarChart :data="uniqueBarData" :height="200" />
          </div>
        </div>

        <!-- 明细表 -->
        <div class="border-t border-gray-200 dark:border-gray-800">
          <table class="w-full text-sm">
            <thead class="text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th class="px-5 py-2 text-left font-medium">成员</th>
                <th class="px-3 py-2 text-right font-medium">表情数</th>
                <th class="px-3 py-2 text-right font-medium">种类</th>
                <th class="px-3 py-2 text-right font-medium">表情占比</th>
                <th class="hidden px-5 py-2 text-right font-medium sm:table-cell">最爱用</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="member in analysis.members"
                :key="member.memberId"
                class="border-t border-gray-100 dark:border-gray-800/60"
              >
                <td class="px-5 py-2.5 font-medium text-gray-900 dark:text-white">{{ member.name }}</td>
                <td class="px-3 py-2.5 text-right font-bold text-pink-600 dark:text-pink-400">
                  {{ member.stickerCount.toLocaleString() }}
                </td>
                <td class="px-3 py-2.5 text-right text-gray-600 dark:text-gray-300">{{ member.uniqueCount }}</td>
                <td class="px-3 py-2.5 text-right text-gray-600 dark:text-gray-300">{{ member.ratio }}%</td>
                <td class="hidden px-5 py-2.5 text-right text-gray-600 dark:text-gray-300 sm:table-cell">
                  <span v-if="member.topLabel">
                    {{ member.topLabel }}
                    <span class="text-xs text-gray-400">×{{ member.topCount }}</span>
                  </span>
                  <span v-else>-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <!-- 热门表情 Top -->
      <SectionCard title="热门表情 Top 12" description="按 md5 聚合，同一表情只算一项">
        <div class="divide-y divide-gray-100 dark:divide-gray-800/60">
          <div
            v-for="(item, index) in topStickers"
            :key="item.stickerId"
            class="flex items-center gap-3 px-5 py-3"
          >
            <span
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold"
              :class="
                index === 0
                  ? 'bg-amber-500 text-white'
                  : index === 1
                    ? 'bg-gray-400 text-white'
                    : index === 2
                      ? 'bg-amber-700 text-white'
                      : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
              "
            >
              {{ index + 1 }}
            </span>

            <img
              v-if="item.previewUrl"
              :src="item.previewUrl"
              :alt="item.label"
              class="h-9 w-9 shrink-0 rounded object-contain"
              referrerpolicy="no-referrer"
              @error="($event.target as HTMLImageElement).style.display = 'none'"
            />
            <span
              v-else
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-gray-100 text-base dark:bg-gray-800"
            >
              🙂
            </span>

            <div class="min-w-0 flex-1">
              <div class="flex items-center justify-between gap-2">
                <span class="truncate text-sm font-medium text-gray-900 dark:text-white">{{ item.label }}</span>
                <span class="shrink-0 text-sm font-bold text-pink-600 dark:text-pink-400">
                  {{ item.count.toLocaleString() }} 次
                </span>
              </div>
              <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                <div
                  class="h-full rounded-full bg-gradient-to-r from-pink-400 to-pink-600"
                  :style="{ width: barWidth(item.count) }"
                />
              </div>
              <p class="mt-1 truncate text-xs text-gray-400">{{ memberSplit(item) }}</p>
            </div>
          </div>
        </div>
      </SectionCard>

      <!-- 趋势 -->
      <SectionCard
        :title="trendIsMonthly ? '表情使用趋势（按月）' : '表情使用趋势（按天）'"
        description="这段时间你们发了多少表情"
      >
        <div class="p-5">
          <LineChart :data="trendData" :height="220" line-color="#ec4899" fill-color="rgba(236, 72, 153, 0.1)" />
        </div>
      </SectionCard>

      <!-- 共享 / 独有 -->
      <SectionCard
        v-if="analysis.exclusive.length > 0"
        title="表情口味差异"
        description="各自独有的表情数量，越多说明各有各的梗"
      >
        <div class="flex flex-wrap gap-3 p-5">
          <div
            v-for="item in analysis.exclusive"
            :key="item.memberId"
            class="rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-800"
          >
            <p class="text-sm text-gray-500 dark:text-gray-400">{{ item.name }} 独有</p>
            <p class="text-xl font-black text-amber-600 dark:text-amber-400">{{ item.count }} 种</p>
          </div>
        </div>
      </SectionCard>

      <!-- 文字表情 -->
      <SectionCard
        v-if="textEmoji.length > 0"
        title="文字表情排行"
        description="聊天文字里出现的 [呲牙]、[旺柴] 这类表情"
      >
        <div class="flex flex-wrap gap-2 p-5">
          <span
            v-for="emoji in textEmoji"
            :key="emoji.label"
            class="inline-flex items-center gap-1 rounded-full border border-gray-200 px-3 py-1 text-sm dark:border-gray-700"
            :class="emoji.count > maxTextEmojiCount * 0.6 ? 'text-pink-600 dark:text-pink-400' : 'text-gray-700 dark:text-gray-300'"
          >
            [{{ emoji.label }}]
            <span class="text-xs font-semibold text-gray-400">×{{ emoji.count }}</span>
          </span>
        </div>
      </SectionCard>
    </template>
  </div>
</template>
