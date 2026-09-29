import {
  WORKSPACE_SCHEMA_VERSION,
  regionLabels,
  workspaceStateSchema,
  type ConflictRecord,
  type PrivacyRequest,
  type SystemReceipt,
  type WorkspaceState,
} from '@/lib/schemas'
import { regionTemplates } from './workflow'

const MIGRATION_OPERATOR = '系统迁移补齐'
const MIGRATED_AT = '2026-09-29T00:00:00.000Z'

function daysBetween(from: string, to: string): number {
  const diff = new Date(to).getTime() - new Date(from).getTime()
  return Math.round(diff / 86_400_000)
}

/** 旧版冲突是纯字符串；迁移为结构化冲突，默认未复核，必须人工过一遍才能关闭。 */
function migrateConflicts(request: PrivacyRequest, legacyConflicts: unknown[]): ConflictRecord[] {
  return legacyConflicts.map((raw, index) => {
    const description = typeof raw === 'string' ? raw : String(raw ?? '').trim()
    return {
      id: `conflict-${request.id}-${index + 1}`,
      description,
      raisedAt: request.requestedAt,
      resolved: false,
    }
  })
}

/** 已完成的执行任务补齐“已接受”回执，标记为迁移回填，不重新生成证据。 */
function backfillReceipts(request: PrivacyRequest): SystemReceipt[] {
  const receipts: SystemReceipt[] = []
  for (const task of request.tasks) {
    if (!task.id.includes('-execute-') || task.status !== 'completed') continue
    const systemId = task.id.split('-execute-')[1]
    if (!systemId) continue
    const relatedEvidence = request.evidence.find((item) => item.stepId === task.id)
    receipts.push({
      id: `receipt-${request.id}-${systemId}`,
      systemId,
      taskId: task.id,
      idempotencyKey: `MIGRATED-${request.code}-${systemId}`,
      status: 'accepted',
      operator: task.assignee || MIGRATION_OPERATOR,
      receivedAt: task.completedAt ?? relatedEvidence?.uploadedAt ?? request.requestedAt,
      payloadSummary: '旧版工作区无回执记录，按已完成执行任务回填。',
      receiptDigest: relatedEvidence?.digest ?? `BK-${request.code}-${systemId}`,
      backfilled: true,
      attempts: [
        {
          id: `attempt-${request.id}-${systemId}-migration`,
          kind: 'accepted',
          operator: MIGRATION_OPERATOR,
          receivedAt: MIGRATED_AT,
          note: '迁移回填：沿用任务完成时间，未重新生成证据。',
        },
      ],
    })
  }
  return receipts
}

/** 旧数据没有模板快照；按原到期日反算天数冻结模板，沿用原到期日不变。 */
function freezeLegacyTemplate(request: PrivacyRequest) {
  const current = regionTemplates[request.region]
  const elapsed = daysBetween(request.requestedAt, request.dueAt)
  const responseDays =
    Number.isFinite(elapsed) && elapsed >= 1 && elapsed <= 365
      ? elapsed
      : current.responseDays
  return {
    region: request.region,
    version: `${current.version}-legacy`,
    responseDays,
    frozenAt: MIGRATED_AT,
  }
}

function migrateRequest(raw: PrivacyRequest & { conflicts?: unknown }): PrivacyRequest {
  const request = structuredClone(raw) as PrivacyRequest

  // 期限模板冻结快照：只补齐快照，绝不重算到期日。
  request.deadlineTemplate = request.deadlineTemplate ?? freezeLegacyTemplate(request)
  request.schemaVersion = WORKSPACE_SCHEMA_VERSION
  request.receipts = request.receipts ?? []

  // 结构化冲突迁移。
  const legacyConflicts = (raw.conflicts ?? []) as unknown[]
  const alreadyStructured = legacyConflicts.every(
    (item) => item && typeof item === 'object' && 'description' in item,
  )
  if (!alreadyStructured) {
    request.conflicts = migrateConflicts(request, legacyConflicts)
  }

  // 身份核验记录补齐：有结论但缺 reviewedAt/reviewedBy 时补核验时间与核验人，沿用原结论。
  if (request.identity.status !== 'pending') {
    const identityEvidence = request.evidence.find((item) => item.stepId.endsWith('-identity'))
    request.identity.reviewedAt =
      request.identity.reviewedAt ?? identityEvidence?.uploadedAt ?? request.requestedAt
    request.identity.reviewedBy =
      request.identity.reviewedBy ?? identityEvidence?.uploadedBy ?? '迁移补齐核验人'
  }

  // 已完成执行任务回填回执。
  const backfilled = backfillReceipts(request)
  const existingSystemIds = new Set(request.receipts.map((item) => item.systemId))
  request.receipts.push(...backfilled.filter((item) => !existingSystemIds.has(item.systemId)))

  // 所有执行任务均有已接受回执且已完成合并节点时，回填合并记录，保证旧的“待关闭/已完成”数据自洽。
  const executable = request.tasks.filter(
    (task) => task.id.includes('-execute-') && task.systemId,
  )
  const acceptedSystemIds = new Set(
    request.receipts
      .filter((receipt) => receipt.status === 'accepted')
      .map((receipt) => receipt.systemId),
  )
  const allReceiptsIn =
    executable.length > 0 &&
    executable.every((task) => acceptedSystemIds.has(task.systemId as string))
  const mergeTask = request.tasks.find((task) => task.id.endsWith('-merge'))
  if (allReceiptsIn && mergeTask?.status === 'completed' && !request.merge) {
    request.merge = {
      mergedAt: mergeTask.completedAt ?? MIGRATED_AT,
      mergedBy: MIGRATION_OPERATOR,
      note: '旧版工作区无合并记录，按全部系统已完成事实回填，原始任务与证据时间未改动。',
      receiptIds: request.receipts.map((receipt) => receipt.id),
    }
  }

  request.audit = [
    {
      id: `audit-migration-${request.id}`,
      action: '旧版工作区数据迁移',
      operator: MIGRATION_OPERATOR,
      detail: `补齐 ${regionLabels[request.region]} 期限模板快照（${request.deadlineTemplate.version}，${request.deadlineTemplate.responseDays} 日）与核验记录，沿用原到期日；回填 ${backfilled.length} 份系统回执，冲突按未复核处理需人工确认。`,
      createdAt: MIGRATED_AT,
    },
    ...request.audit,
  ]

  return request
}

/**
 * 迁移浏览器中无版本号的旧工作区数据：
 * 1) 补齐期限模板快照，沿用原到期日；
 * 2) 补齐身份核验记录；
 * 3) 已完成执行任务回填回执；
 * 4) 字符串冲突升级为结构化、未复核冲突。
 * 迁移不改写任何业务时间点，仅追加迁移审计。
 */
export function migrateWorkspace(parsed: unknown): WorkspaceState | null {
  if (!parsed || typeof parsed !== 'object') return null
  const legacy = parsed as WorkspaceState & { requests?: unknown[] }
  if (!Array.isArray(legacy.requests)) return null

  // 已是当前结构版本：迁移幂等，原样返回不追加任何审计。
  if (legacy.schemaVersion === WORKSPACE_SCHEMA_VERSION) {
    const current = workspaceStateSchema.safeParse(legacy)
    return current.success ? current.data : null
  }

  const migrated = structuredClone(legacy) as WorkspaceState
  migrated.requests = (legacy.requests as PrivacyRequest[]).map((request) => migrateRequest(request))
  migrated.schemaVersion = WORKSPACE_SCHEMA_VERSION

  // 全局审计补一条迁移记录（不增加 revision，迁移是同一状态的规范化）。
  if (!migrated.audit.some((entry) => entry.action === '旧版工作区数据迁移')) {
    migrated.audit = [
      {
        id: 'audit-migration-workspace',
        action: '旧版工作区数据迁移',
        operator: MIGRATION_OPERATOR,
        detail: `工作区升级到结构版本 v${WORKSPACE_SCHEMA_VERSION}：冻结期限模板、补齐核验记录、回填跨系统回执，旧请求原到期日保持不变。`,
        createdAt: MIGRATED_AT,
      },
      ...migrated.audit,
    ]
  }

  const revalidated = workspaceStateSchema.safeParse(migrated)
  return revalidated.success ? revalidated.data : null
}
