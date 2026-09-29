import type { WorkspaceState } from '@/types/domain'
import { workspaceStateSchema } from './schemas'
import { migrateWorkspace } from '@/services/migration'

const STORAGE_KEY = 'privacy-rights-workbench-v1'

/**
 * 加载浏览器工作区。无版本号的旧数据无法通过当前 schema 校验时，
 * 走迁移流程：补齐冻结模板、核验记录与系统回执，沿用原到期日，
 * 迁移成功后立即回写 localStorage。
 */
export function loadWorkspace(): WorkspaceState | null {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const current = workspaceStateSchema.safeParse(parsed)
  if (current.success) return current.data

  const migrated = migrateWorkspace(parsed)
  if (migrated) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
    return migrated
  }
  return null
}

export function saveWorkspace(state: WorkspaceState): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function clearWorkspace(): void {
  if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY)
}
