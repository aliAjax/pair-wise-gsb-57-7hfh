import type { WorkspaceState } from '@/types/domain'
import { CURRENT_SCHEMA_VERSION, workspaceStateSchema } from './schemas'
import { migrateWorkspace, needsMigration } from '@/services/migration'

const STORAGE_KEY = 'privacy-rights-workbench-v1'

function parseAndUpgrade(raw: string): WorkspaceState | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  // 旧浏览器数据没有版本号：首次打开执行迁移补齐，再按新版本结构校验
  if (needsMigration(data)) {
    const migrated = migrateWorkspace(data)
    saveWorkspace(migrated)
    return migrated
  }
  const parsed = workspaceStateSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

export function loadWorkspace(): WorkspaceState | null {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  return parseAndUpgrade(raw)
}

export function saveWorkspace(state: WorkspaceState): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ ...state, schemaVersion: CURRENT_SCHEMA_VERSION }),
  )
}

export function clearWorkspace(): void {
  if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY)
}

/**
 * 订阅其他标签页/系统对同一工作区的写入。
 * 处理动作绑定版本后，旧页面一旦读到更新的整包状态就同步到本地缓存，
 * 避免它再用过期版本整包覆盖其他系统刚完成的任务和审计。
 */
export function subscribeWorkspace(listener: (state: WorkspaceState) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    const state = parseAndUpgrade(event.newValue)
    if (state) listener(state)
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}
