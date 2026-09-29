import { z } from 'zod'

/** 浏览器本地数据结构版本：旧版本数据首次加载时需要迁移补齐 */
export const CURRENT_SCHEMA_VERSION = 2

export const requestTypeSchema = z.enum([
  'access',
  'rectification',
  'deletion',
  'withdraw-consent',
  'restriction',
])

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

export const identitySchema = z.object({
  status: z.enum(['pending', 'verified', 'insufficient']),
  materialType: z.enum(['masked-id', 'account-ownership', 'authorization-letter', 'none']),
  maskedReference: z.string(),
  protectedDigest: z.string(),
  note: z.string(),
  reviewedAt: z.string().optional(),
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
  // 幂等来源：系统回执登记的证据绑定回执键；人工登记为空；旧数据迁移补齐为 legacy-backfill
  receiptKey: z.string().optional(),
  source: z.enum(['receipt', 'manual', 'legacy-backfill']).default('manual'),
})

/**
 * 跨系统处理回执。
 * receiptKey 为来源系统给出的幂等键（回执编号），同一笔回执超时重发时保持不变，
 * 服务端按 requestId + systemId + receiptKey 去重：只有首次被“接受”，重发只更新投递记录。
 */
export const systemReceiptSchema = z.object({
  id: z.string(),
  systemId: z.string(),
  receiptKey: z.string(),
  status: z.enum(['accepted', 'failed']),
  summary: z.string(),
  receivedAt: z.string(),
  /** 最近一次（可能是重发）送达时间 */
  lastDeliveryAt: z.string(),
  deliveryCount: z.number().int().positive(),
  operator: z.string(),
  /** 同一幂等键被重复投递的记录，仅作留痕，不产生新证据、不推进任务 */
  redeliveries: z.array(
    z.object({
      deliveredAt: z.string(),
      operator: z.string(),
      note: z.string(),
    }),
  ),
  /** 回执被判为失败/例外时生成的冲突说明，等待人工复核 */
  conflict: z.string().optional(),
})

export const deadlineTemplateSchema = z.object({
  region: regionSchema,
  days: z.number(),
  templateVersion: z.string(),
  frozenAt: z.string(),
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
  /** 请求级版本号（乐观锁），每次被接受的处理动作 +1，处理动作必须绑定当前版本 */
  version: z.number(),
  requesterName: z.string(),
  requesterContact: z.string(),
  region: regionSchema,
  type: requestTypeSchema,
  status: requestStatusSchema,
  identity: identitySchema,
  requestedAt: z.string(),
  dueAt: z.string(),
  /** 登记时冻结的地区期限模板；之后模板调整不影响本请求 */
  deadlineTemplate: deadlineTemplateSchema,
  extendedDays: z.number(),
  duplicateOf: z.string().optional(),
  affectedSystemIds: z.array(z.string()),
  tasks: z.array(workflowStepSchema),
  evidence: z.array(evidenceSchema),
  /** 各数据系统处理回执，按 receiptKey 幂等登记 */
  systemReceipts: z.array(systemReceiptSchema),
  conflicts: z.array(z.string()),
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
  /** 本地数据结构版本，旧浏览器数据首次打开时迁移到当前版本 */
  schemaVersion: z.number().default(CURRENT_SCHEMA_VERSION),
})

/**
 * 所有处理动作都必须携带期望版本：
 * 服务端只接受“当前版本”的动作，旧页面整包提交时会收到版本冲突，避免覆盖其他系统刚完成的任务。
 */
const expectedVersion = z.number().int().nonnegative()

export const saveRequestInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  expectedVersion,
  patch: z.object({
    requesterName: z.string().min(2).optional(),
    requesterContact: z.string().min(5).optional(),
  }),
  operator: z.string().default('当前用户'),
})

export const createRequestInputSchema = z.object({
  state: workspaceStateSchema,
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
  requestId: z.string(),
  expectedVersion,
  status: z.enum(['verified', 'insufficient']),
  note: z.string(),
  operator: z.string(),
})

export const assignTaskInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  expectedVersion,
  taskId: z.string(),
  assignee: z.string().min(2),
  operator: z.string(),
})

export const taskActionInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  expectedVersion,
  taskId: z.string(),
  action: z.enum(['start', 'complete', 'block']),
  note: z.string(),
  operator: z.string(),
})

export const evidenceInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  expectedVersion,
  taskId: z.string(),
  name: z.string().min(2),
  evidenceType: evidenceSchema.shape.evidenceType,
  operator: z.string(),
})

export const registerReceiptInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  expectedVersion,
  systemId: z.string(),
  // 来源系统回执编号，作为幂等键；超时重发必须携带同一编号
  receiptKey: z.string().min(3),
  result: z.enum(['accepted', 'failed']),
  summary: z.string().min(2),
  note: z.string(),
  operator: z.string(),
})

export const conflictInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  expectedVersion,
  conflict: z.string().min(4),
  operator: z.string(),
})

export const resolveConflictInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  expectedVersion,
  conflictIndex: z.number().int().nonnegative(),
  resolution: z.string().min(4),
  operator: z.string(),
})

export const closeRequestInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  expectedVersion,
  resultSummary: z.string().min(4),
  closureReason: z.string(),
  operator: z.string(),
})

export const extendRequestInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  expectedVersion,
  days: z.number().int().min(1).max(90),
  reason: z.string().min(4),
  operator: z.string(),
})

export const commentInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  expectedVersion,
  content: z.string().min(2),
  operator: z.string(),
})

export const recordExportInputSchema = z.object({
  state: workspaceStateSchema,
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
export type SystemReceipt = z.infer<typeof systemReceiptSchema>
export type DeadlineTemplate = z.infer<typeof deadlineTemplateSchema>
export type ReviewComment = z.infer<typeof commentSchema>
export type AuditEntry = z.infer<typeof auditEntrySchema>
export type DataSystem = z.infer<typeof dataSystemSchema>
export type PrivacyRequest = z.infer<typeof privacyRequestSchema>
export type WorkspaceState = z.infer<typeof workspaceStateSchema>

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
