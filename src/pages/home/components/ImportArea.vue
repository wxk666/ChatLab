<script setup lang="ts">
import { FileDropZone } from '@/components/UI'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'

const sessionStore = useSessionStore()
const { isImporting, importProgress } = storeToRefs(sessionStore)

const importError = ref<string | null>(null)
const hasImportLog = ref(false)

const router = useRouter()

// 根据会话类型导航到对应页面
async function navigateToSession(sessionId: string) {
  const session = await window.chatApi.getSession(sessionId)
  if (session) {
    const routeName = session.type === 'private' ? 'private-chat' : 'group-chat'
    router.push({ name: routeName, params: { id: sessionId } })
  }
}

// 检查是否有导入日志
async function checkImportLog() {
  const result = await window.cacheApi.getLatestImportLog()
  hasImportLog.value = result.success && !!result.path
}

// 处理文件选择（点击选择）
async function handleClickImport() {
  importError.value = null
  hasImportLog.value = false
  const result = await sessionStore.importFile()
  if (!result.success && result.error && result.error !== '未选择文件') {
    importError.value = result.error
    await checkImportLog()
  } else if (result.success && sessionStore.currentSessionId) {
    await navigateToSession(sessionStore.currentSessionId)
  }
}

// 处理文件夹导入（自动关联表情包图片）
async function handleClickImportFolder() {
  importError.value = null
  hasImportLog.value = false
  const result = await sessionStore.importFolder()
  if (!result.success && result.error && result.error !== '未选择文件夹') {
    importError.value = result.error
    await checkImportLog()
  } else if (result.success && sessionStore.currentSessionId) {
    await navigateToSession(sessionStore.currentSessionId)
  }
}

// 处理文件拖拽
async function handleFileDrop({ paths }: { files: File[]; paths: string[] }) {
  if (paths.length === 0) {
    importError.value = '无法读取文件路径'
    return
  }

  importError.value = null
  hasImportLog.value = false
  const result = await sessionStore.importFileFromPath(paths[0])
  if (!result.success && result.error) {
    importError.value = result.error
    await checkImportLog()
  } else if (result.success && sessionStore.currentSessionId) {
    await navigateToSession(sessionStore.currentSessionId)
  }
}

function openTutorial() {
  window.open('https://chatlab.fun/usage/how-to-export.html?utm_source=app', '_blank')
}

// 打开最新的导入日志文件
async function openLatestImportLog() {
  const result = await window.cacheApi.getLatestImportLog()
  if (result.success && result.path) {
    await window.cacheApi.showInFolder(result.path)
  } else {
    // 没有日志文件时，打开日志目录
    await window.cacheApi.openDir('logs')
  }
}

function getProgressText(): string {
  if (!importProgress.value) return ''
  switch (importProgress.value.stage) {
    case 'detecting':
      return '正在检测格式...'
    case 'reading':
      return '正在读取文件...'
    case 'parsing':
      return '正在解析消息...'
    case 'saving':
      return '正在写入数据库...'
    case 'importing':
      return '正在处理数据...'
    case 'done':
      return '导入完成'
    case 'error':
      return '导入中断'
    default:
      return ''
  }
}

function getProgressDetail(): string {
  if (!importProgress.value) return ''
  const { messagesProcessed, totalBytes, bytesRead } = importProgress.value

  if (messagesProcessed && messagesProcessed > 0) {
    return `已处理 ${messagesProcessed.toLocaleString()} 条消息`
  }

  if (totalBytes && bytesRead) {
    const percent = Math.round((bytesRead / totalBytes) * 100)
    const mbRead = (bytesRead / 1024 / 1024).toFixed(1)
    const mbTotal = (totalBytes / 1024 / 1024).toFixed(1)
    return `${mbRead} MB / ${mbTotal} MB (${percent}%)`
  }

  return importProgress.value.message || ''
}
</script>

<template>
  <div class="flex flex-col items-center space-y-6">
    <!-- Import Drop Zone -->
    <FileDropZone
      :accept="['*']"
      :disabled="isImporting"
      class="w-full max-w-4xl"
      @files="handleFileDrop"
    >
      <template #default="{ isDragOver }">
        <div
          class="group relative flex w-full cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-pink-300/50 bg-white/50 px-8 py-8 backdrop-blur-sm transition-all duration-300 hover:border-pink-400 hover:bg-white/80 hover:shadow-lg hover:shadow-pink-500/10 focus:outline-none focus:ring-4 focus:ring-pink-500/20 sm:px-12 sm:py-12 dark:border-pink-700/50 dark:bg-gray-900/50 dark:hover:border-pink-500 dark:hover:bg-gray-900/80"
          :class="{
            'border-pink-500 bg-pink-50/50 dark:border-pink-400 dark:bg-pink-900/20': isDragOver && !isImporting,
            'cursor-not-allowed opacity-70': isImporting,
            'hover:scale-[1.02]': !isImporting,
          }"
          @click="!isImporting && handleClickImport()"
        >
          <!-- Icon -->
          <div
            class="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-linear-to-br from-pink-100 to-rose-100 transition-transform duration-300 dark:from-pink-900/30 dark:to-rose-900/30"
            :class="{ 'scale-110': isDragOver && !isImporting, 'animate-pulse': isImporting }"
          >
            <UIcon
              v-if="!isImporting"
              name="i-heroicons-arrow-up-tray"
              class="h-8 w-8 text-pink-600 transition-transform group-hover:-translate-y-1 dark:text-pink-400"
            />
            <UIcon v-else name="i-heroicons-arrow-path" class="h-8 w-8 animate-spin text-pink-600 dark:text-pink-400" />
          </div>

          <!-- Text -->
          <div class="w-full min-w-80 text-center">
            <template v-if="isImporting && importProgress">
              <!-- 导入中显示进度 -->
              <p class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">{{ getProgressText() }}</p>
              <div class="mx-auto w-full max-w-md">
                <UProgress v-model="importProgress.progress" size="md" />
              </div>
              <p class="mt-3 text-sm text-gray-500 dark:text-gray-400">
                {{ getProgressDetail() }}
              </p>
            </template>
            <template v-else>
              <!-- 默认状态 -->
              <p class="text-lg font-semibold text-gray-900 dark:text-white">
                {{ isDragOver ? '松开鼠标导入文件/文件夹' : '点击选择或拖拽聊天记录导入' }}
              </p>
            </template>
          </div>
        </div>
      </template>
    </FileDropZone>

    <!-- Error Message -->
    <div v-if="importError" class="flex flex-col items-center gap-3 rounded-lg bg-red-50 px-4 py-4 dark:bg-red-900/20">
      <div class="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
        <UIcon name="i-heroicons-exclamation-circle" class="h-5 w-5 shrink-0" />
        <span>{{ importError }}</span>
      </div>
      <UButton v-if="hasImportLog" size="xs" @click="openLatestImportLog">查看导入日志</UButton>
    </div>

    <div class="flex flex-wrap items-center justify-center gap-3">
      <UButton color="neutral" variant="outline" :disabled="isImporting" @click="handleClickImportFolder">
        <UIcon name="i-heroicons-folder-open" class="mr-1 h-4 w-4" />
        选择文件夹导入（含表情包图片）
      </UButton>
      <UButton @click="openTutorial">查看聊天记录导入教程 →</UButton>
    </div>
  </div>
</template>
