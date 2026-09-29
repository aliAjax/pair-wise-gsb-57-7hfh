import { z } from 'zod'

export const requestTypeSchema = z.enum([
  'access',
  'rectification',
  'deletion',
  'withdraw-consent',
  'restriction',
])

export const WORKSPACE_SCHEMA_VERSION = 2

export const requestStatusSchema = z.enum([
  'registered',
  'identity-review',
  'processing',
  'review-required',
  'pending-close',
  'completed',
  'rejected',
  'extended',
])

export const regionSchema = z.enum(['cn', 'eu', 'us', 'sg'])

/**
 * 登记时冻结的期限模板快照。请求登记后地区模板改版只影响新登记请求，
 * 已登记请求始终按快照计算期限（延期在快照天数基础上叠加）。
 */
export const deadlineTemplateSchema = z.object({
  region: regionSchema,
  version: z.string(),
  responseDays: z.number().int().positive(),
  frozenAt: z.string(),
})

export const identitySchema = z.object({
  status: z.enum(['pending', 'verified', 'insufficient']),
  materialType: z.enum(['masked-id', 'account-ownership', 'authorization-letter', 'none']),
  maskedReference: z.string(),
  protectedDigest: z.string(),
  note: z.string(),
  reviewedAt: z.string().optional(),
  reviewedBy: z.string().optional(),
})

export const workflowStepSchema = z.object({
  id: z.string(),
  order: z.number(),
  name: z.string(),
  role: z.string(),
  systemId: z.string().optional(),
  status: z.enum(['pending', 'active', 'completed', 'blocked']),
  assignee: z.string(),
  dueAt: z.string(),
  completedAt: z.string().optional(),
  exceptionReason: z.string(),
})

export const evidenceSchema = z.object({
  id: z.string(),
  stepId: z.string(),
  name: z.string(),
  evidenceType: z.enum(['execution-log', 'screenshot', 'signed-record', 'system-response']),
  digest: z.string(),
  uploadedBy: z.string(),
  uploadedAt: z.string(),
  protected: z.literal(true),
  /** 回执证据对应回执的幂等键，用于核对“同一笔回执只生成一份证据”。 */
  receiptKey: z.string().optional(),
})

export const receiptAttemptSchema = z.object({
  id: z.string(),
  kind: z.enum(['accepted', 'resent', 'conflict']),
  operator: z.string(),
  receivedAt: z.string(),
  note: z.string(),
})

/**
 * 单个系统的处理回执。一个系统只有一个逻辑回执：首次成功登记为 accepted，
 * 超时重发按同一幂等键（或同系统已接受）认作同一笔，仅追加 resent 尝试，
 * 不再生成证据；回执声明结果与其他系统不一致时记为 conflict。
 */
export const systemReceiptSchema = z.object({
  id: z.string(),
  systemId: z.string(),
  taskId: z.string(),
  idempotencyKey: z.string(),
  status: z.enum(['accepted', 'conflict']),
  operator: z.string(),
  receivedAt: z.string(),
  payloadSummary: z.string(),
  receiptDigest: z.string(),
  backfilled: z.boolean().optional(),
  attempts: z.array(receiptAttemptSchema),
})

/**
 * 结构化冲突：只有记录了复核人、复核时间与复核结论才算已复核，
 * 未复核冲突存在时服务端拒绝关闭请求。
 */
export const conflictRecordSchema = z.object({
  id: z.string(),
  description: z.string(),
  raisedAt: z.string(),
  resolved: z.boolean(),
  resolution: z.string().optional(),
  resolvedBy: z.string().optional(),
  resolvedAt: z.string().optional(),
})

export const mergeRecordSchema = z.object({
  mergedAt: z.string(),
  mergedBy: z.string(),
  note: z.string(),
  receiptIds: z.array(z.string()),
})

export const commentSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  author: z.string(),
  content: z.string(),
  createdAt: z.string(),
})

export const auditEntrySchema = z.object({
  id: z.string(),
  requestId: z.string().optional(),
  action: z.string(),
  operator: z.string(),
  detail: z.string(),
  createdAt: z.string(),
})

export const dataSystemSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.string(),
  dataDomain: z.string(),
  transferMethod: z.string(),
  slaDays: z.number(),
  requestTypes: z.array(requestTypeSchema),
  status: z.enum(['active', 'maintenance', 'retired']),
})

export const privacyRequestSchema = z.object({
  id: z.string(),
  code: z.string(),
  requesterName: z.string(),
  requesterContact: z.string(),
  region: regionSchema,
  type: requestTypeSchema,
  status: requestStatusSchema,
  identity: identitySchema,
  requestedAt: z.string(),
  dueAt: z.string(),
  /** 登记时冻结的期限模板；v1 旧数据首次加载时迁移补齐。 */
  deadlineTemplate: deadlineTemplateSchema.optional(),
  /** 请求记录结构版本，随工作区迁移补齐。 */
  schemaVersion: z.number().optional(),
  extendedDays: z.number(),
  duplicateOf: z.string().optional(),
  affectedSystemIds: z.array(z.string()),
  tasks: z.array(workflowStepSchema),
  evidence: z.array(evidenceSchema),
  conflicts: z.array(conflictRecordSchema),
  receipts: z.array(systemReceiptSchema).optional(),
  merge: mergeRecordSchema.optional(),
  resultSummary: z.string(),
  closureReason: z.string(),
  audit: z.array(
    auditEntrySchema.omit({ requestId: true }),
  ),
})

export const workspaceStateSchema = z.object({
  requests: z.array(privacyRequestSchema),
  systems: z.array(dataSystemSchema),
  comments: z.array(commentSchema),
  audit: z.array(auditEntrySchema),
  revision: z.number(),
  schemaVersion: z.number().optional(),
})

/**
 * 所有变更动作必须携带打开页面时看到的工作区版本号；
 * 服务端按当前版本校验，版本过期（其他页面/系统已先行保存）即拒绝整包写入。
 */
const revisionGuard = { expectedRevision: z.number().int().nonnegative() }

/** save 只允许修改基本联系信息，冻结字段与版本字段不得由整包补丁覆盖。 */
const requestEditablePatch = z.object({
  requesterName: z.string().min(2).optional(),
  requesterContact: z.string().min(5).optional(),
})

export const saveRequestInputSchema = z.object({
  state: workspaceStateSchema,
  ...revisionGuard,
  requestId: z.string(),
  patch: requestEditablePatch,
  operator: z.string().default('当前用户'),
})

export const createRequestInputSchema = z.object({
  state: workspaceStateSchema,
  ...revisionGuard,
  input: z.object({
    requesterName: z.string().min(2),
    requesterContact: z.string().min(5),
    region: regionSchema,
    type: requestTypeSchema,
    affectedSystemIds: z.array(z.string()).min(1),
    identityMaterialType: identitySchema.shape.materialType,
    identityReference: z.string(),
    note: z.string(),
  }),
  operator: z.string().default('客服专员'),
})

export const identityInputSchema = z.object({
  state: workspaceStateSchema,
  ...revisionGuard,
  requestId: z.string(),
  status: z.enum(['verified', 'insufficient']),
  note: z.string(),
  operator: z.string(),
})

export const assignTaskInputSchema = z.object({
  state: workspaceStateSchema,
  ...revisionGuard,
  requestId: z.string(),
  taskId: z.string(),
  assignee: z.string().min(2),
  operator: z.string(),
})

export const taskActionInputSchema = z.object({
  state: workspaceStateSchema,
  ...revisionGuard,
  requestId: z.string(),
  taskId: z.string(),
  action: z.enum(['start', 'complete', 'block']),
  note: z.string(),
  operator: z.string(),
})

export const evidenceInputSchema = z.object({
  state: workspaceStateSchema,
  ...revisionGuard,
  requestId: z.string(),
  taskId: z.string(),
  name: z.string().min(2),
  evidenceType: evidenceSchema.shape.evidenceType,
  operator: z.string(),
})

export const receiptInputSchema = z.object({
  state: workspaceStateSchema,
  ...revisionGuard,
  requestId: z.string(),
  systemId: z.string(),
  /** 外部回执编号，作为幂等键；超时重发沿用同一编号。 */
  idempotencyKey: z.string().min(4),
  outcome: z.enum(['success', 'conflict']),
  payloadSummary: z.string().min(2),
  note: z.string().default(''),
  /** 重发登记：调用方明确告知这是超时后的补发回执。 */
  isResend: z.boolean().default(false),
  operator: z.string(),
})

export const mergeInputSchema = z.object({
  state: workspaceStateSchema,
  ...revisionGuard,
  requestId: z.string(),
  note: z.string().min(4),
  operator: z.string(),
})

export const conflictInputSchema = z.object({
  state: workspaceStateSchema,
  ...revisionGuard,
  requestId: z.string(),
  conflict: z.string().min(4),
  operator: z.string(),
})

export const resolveConflictInputSchema = z.object({
  state: workspaceStateSchema,
  ...revisionGuard,
  requestId: z.string(),
  conflictId: z.string(),
  resolution: z.string().min(4),
  operator: z.string(),
})

export const closeRequestInputSchema = z.object({
  state: workspaceStateSchema,
  ...revisionGuard,
  requestId: z.string(),
  resultSummary: z.string().min(4),
  closureReason: z.string(),
  operator: z.string(),
})

export const extendRequestInputSchema = z.object({
  state: workspaceStateSchema,
  ...revisionGuard,
  requestId: z.string(),
  days: z.number().int().min(1).max(90),
  reason: z.string().min(4),
  operator: z.string(),
})

export const commentInputSchema = z.object({
  state: workspaceStateSchema,
  ...revisionGuard,
  requestId: z.string(),
  content: z.string().min(2),
  operator: z.string(),
})

export const recordExportInputSchema = z.object({
  state: workspaceStateSchema,
  ...revisionGuard,
  scope: z.string(),
  count: z.number().int().nonnegative(),
  operator: z.string(),
})

export type RequestType = z.infer<typeof requestTypeSchema>
export type RequestStatus = z.infer<typeof requestStatusSchema>
export type Region = z.infer<typeof regionSchema>
export type IdentityCheck = z.infer<typeof identitySchema>
export type WorkflowStep = z.infer<typeof workflowStepSchema>
export type ExecutionEvidence = z.infer<typeof evidenceSchema>
export type ReviewComment = z.infer<typeof commentSchema>
export type AuditEntry = z.infer<typeof auditEntrySchema>
export type DataSystem = z.infer<typeof dataSystemSchema>
export type PrivacyRequest = z.infer<typeof privacyRequestSchema>
export type WorkspaceState = z.infer<typeof workspaceStateSchema>
export type DeadlineTemplate = z.infer<typeof deadlineTemplateSchema>
export type SystemReceipt = z.infer<typeof systemReceiptSchema>
export type ReceiptAttempt = z.infer<typeof receiptAttemptSchema>
export type ConflictRecord = z.infer<typeof conflictRecordSchema>
export type MergeRecord = z.infer<typeof mergeRecordSchema>

export const requestTypeLabels: Record<RequestType, string> = {
  access: '访问',
  rectification: '更正',
  deletion: '删除',
  'withdraw-consent': '撤回同意',
  restriction: '限制处理',
}

export const requestStatusLabels: Record<RequestStatus, string> = {
  registered: '已登记',
  'identity-review': '身份核验中',
  processing: '履约处理中',
  'review-required': '复核队列',
  'pending-close': '待关闭',
  completed: '已完成',
  rejected: '已拒绝',
  extended: '已延期',
}

export const regionLabels: Record<Region, string> = {
  cn: '中国大陆',
  eu: '欧盟',
  us: '美国加州',
  sg: '新加坡',
}

export const systemStatusLabels: Record<DataSystem['status'], string> = {
  active: '在用',
  maintenance: '维护中',
  retired: '已退役',
}

export const receiptStatusLabels: Record<SystemReceipt['status'], string> = {
  accepted: '已接受',
  conflict: '结果冲突',
}

export const receiptAttemptLabels: Record<ReceiptAttempt['kind'], string> = {
  accepted: '首次接受',
  resent: '超时重发',
  conflict: '冲突回执',
}

/**
 * 操作因工作区版本过期被拒绝时抛出的错误码；
 * 前端据此提示“其他页面已更新，请核对后重试”。
 */
export const VERSION_CONFLICT_MESSAGE = '工作区已被其他页面更新（版本过期），请刷新核对后重试'
