import type { WorkspaceState } from '@/types/domain'

/**
 * 乐观并发（多标签页 / 多系统协同时序）：
 *
 * 本工作台服务端无状态，变更时由客户端整包上送工作区，跨标签页共享的
 * “已持久化最新版本”在 localStorage。两个页面同时打开时：
 *   - 页面 B 先保存：持久化版本 R → R+1；
 *   - 页面 A 仍停留在 R，若直接提交会用基于 R 的整包盖掉 B 刚完成的任务与审计。
 * 因此每个处理动作提交前，必须用动作所基于的快照版本对照持久化最新版本，
 * 发现对方已先行保存就拒绝并要求刷新核对，而不是静默覆盖。
 */
export class StaleVersionError extends Error {
  constructor(baseRevision: number, persistedRevision: number) {
    super(
      `工作区已被其他页面或系统更新（动作基于版本 ${baseRevision}，最新版本 ${persistedRevision}），请刷新核对后重试`,
    )
    this.name = 'StaleVersionError'
  }
}

const STORAGE_KEY = 'privacy-rights-workbench-v1'

/** 读取 localStorage 中已持久化工作区的最新版本号（跨标签页的权威版本）。 */
export function readPersistedRevision(): number | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<WorkspaceState> | null
    return typeof parsed?.revision === 'number' ? parsed.revision : null
  } catch {
    return null
  }
}

/**
 * 动作绑定当前版本：快照版本落后于已持久化版本时拒绝提交。
 * 同一标签页内成功的每次保存都会同步推进两处版本，因此正常操作不会误报。
 */
export function assertSnapshotFresh(
  baseRevision: number,
  persistedRevision: number | null,
): void {
  if (persistedRevision !== null && persistedRevision > baseRevision) {
    throw new StaleVersionError(baseRevision, persistedRevision)
  }
}
