import { CURRENT_SCHEMA_VERSION, workspaceStateSchema } from '@/lib/schemas'
import type { PrivacyRequest, WorkspaceState } from '@/types/domain'
import { addDays, freezeDeadlineTemplate, responseDays } from './workflow'

const MIGRATION_AUDIT_ACTION = '旧版工作区数据迁移补齐'
const MIGRATION_NOTE = '旧版本地数据缺少版本号，首次打开时补齐版本、冻结期限模板快照与身份核验记录；沿用原到期日，不重新计算期限。'

let migrationIdCounter = 0
function migrationId(prefix: string) {
  migrationIdCounter += 1
  return `${prefix}-migration-${Date.now()}-${migrationIdCounter}`
}

/**
 * 判断本地数据是否为缺少版本号的旧结构，需要首次打开时迁移。
 */
export function needsMigration(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const data = raw as Partial<WorkspaceState>
  if (!Array.isArray(data.requests)) return false
  if (typeof data.schemaVersion === 'number' && data.schemaVersion >= CURRENT_SCHEMA_VERSION) {
    return false
  }
  return true
}

/**
 * 旧浏览器数据迁移：
 * 1. 补齐工作区/请求版本号；
 * 2. 按请求地区冻结登记时的期限模板快照（模板版本与天数），到期日沿用原值不重算；
 * 3. 已核验通过但缺少核验记录的请求，补登一条受保护核验证据与审计；
 * 4. 新地区模板之后的调整只影响迁移后新登记的请求。
 */
export function migrateWorkspace(raw: unknown): WorkspaceState {
  // 更高版本的数据不做降级迁移，原样校验返回
  if (
    raw &&
    typeof raw === 'object' &&
    'schemaVersion' in raw &&
    typeof (raw as { schemaVersion?: unknown }).schemaVersion === 'number' &&
    ((raw as { schemaVersion: number }).schemaVersion > CURRENT_SCHEMA_VERSION)
  ) {
    const parsed = workspaceStateSchema.safeParse(raw)
    if (parsed.success) return parsed.data
    throw new Error('本地数据来自更新版本的应用，请先升级工作台。')
  }

  const parsed = workspaceStateSchema.safeParse(raw)
  const base = parsed.success
    ? (structuredClone(parsed.data) as WorkspaceState)
    : (structuredClone(raw) as WorkspaceState)

  const migratedAt = new Date().toISOString()
  const alreadyMigrated = base.audit?.some((entry) => entry.action === MIGRATION_AUDIT_ACTION)

  for (const request of base.requests ?? []) {
    migrateRequest(request, migratedAt)
  }

  base.schemaVersion = CURRENT_SCHEMA_VERSION
  if (typeof base.revision !== 'number') base.revision = 1
  base.audit ??= []
  base.comments ??= []
  base.systems ??= []

  if (!alreadyMigrated) {
    base.audit.unshift({
      id: migrationId('audit'),
      action: MIGRATION_AUDIT_ACTION,
      operator: '系统迁移',
      detail: MIGRATION_NOTE,
      createdAt: migratedAt,
    })
  }

  // 再用 schema 校验一次，确保迁移结果结构完整
  const result = workspaceStateSchema.safeParse(base)
  if (!result.success) {
    throw new Error(`旧版本地数据迁移失败：${result.error.message}`)
  }
  return result.data
}

function migrateRequest(request: PrivacyRequest, migratedAt: string) {
  request.systemReceipts ??= []
  request.version ??= 1

  // 期限模板冻结：模板天数取登记时地区模板；到期日沿用旧数据原值
  if (!request.deadlineTemplate) {
    request.deadlineTemplate = freezeDeadlineTemplate(request.region, request.requestedAt)
  }

  // 旧数据可能因延期导致到期日与模板不一致，迁移后保持原到期日不变（这里不做改写，
  // 仅在审计中记录冻结模板与原到期日）
  const expectedDue = addDays(
    new Date(request.requestedAt),
    responseDays[request.region],
  ).toISOString()

  // 已核验通过但缺少核验留痕的，补齐身份核验记录（不改动原核验结论与到期日）
  const hasIdentityEvidence = request.evidence?.some(
    (evidence) => evidence.stepId === `${request.id}-identity`,
  )
  if (request.identity?.status === 'verified' && !hasIdentityEvidence) {
    const reviewedAt = request.identity.reviewedAt ?? request.requestedAt
    if (!request.identity.reviewedAt) request.identity.reviewedAt = reviewedAt
    request.evidence ??= []
    request.evidence.push({
      id: migrationId('evidence'),
      stepId: `${request.id}-identity`,
      name: '身份核验记录（旧版数据补齐）',
      evidenceType: 'signed-record',
      digest: 'LEGACY-IDENTITY-RECORD',
      uploadedBy: '系统迁移',
      uploadedAt: reviewedAt,
      protected: true,
      source: 'legacy-backfill',
    })
  }

  request.audit ??= []
  request.evidence ??= []
  request.tasks ??= []
  request.conflicts ??= []

  const entry = {
    id: migrationId('req-audit'),
    action: MIGRATION_AUDIT_ACTION,
    operator: '系统迁移',
    detail:
      expectedDue === request.dueAt
        ? `补齐版本号与冻结模板快照（${request.deadlineTemplate.templateVersion}，${request.deadlineTemplate.days} 日），沿用原到期日。`
        : `补齐版本号与冻结模板快照（${request.deadlineTemplate.templateVersion}，${request.deadlineTemplate.days} 日），沿用原到期日 ${new Date(request.dueAt).toLocaleDateString('zh-CN')}（含已登记延期），不重新起算。`,
    createdAt: migratedAt,
  }
  if (!request.audit.some((item) => item.action === MIGRATION_AUDIT_ACTION)) {
    request.audit.unshift(entry)
  }
}
