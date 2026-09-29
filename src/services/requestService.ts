import {
  VERSION_CONFLICT_MESSAGE,
  WORKSPACE_SCHEMA_VERSION,
  regionLabels,
  type ConflictRecord,
  type IdentityCheck,
  type PrivacyRequest,
  type RequestStatus,
  type RequestType,
  type Region,
  type SystemReceipt,
  type WorkspaceState,
} from '@/lib/schemas'
import { addDays, buildWorkflowSteps, freezeTemplate } from './workflow'

const cloneState = (state: WorkspaceState): WorkspaceState => structuredClone(state)
const now = () => new Date().toISOString()
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

function digest(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `PD-${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

function appendAudit(
  state: WorkspaceState,
  request: PrivacyRequest,
  action: string,
  operator: string,
  detail: string,
  createdAt?: string,
) {
  const entry = {
    id: id('audit'),
    requestId: request.id,
    action,
    operator,
    detail,
    createdAt: createdAt ?? now(),
  }
  state.audit.unshift(entry)
  request.audit.unshift({
    id: entry.id,
    action,
    operator,
    detail,
    createdAt: entry.createdAt,
  })
}

/**
 * 版本守卫：每个处理动作都绑定调用方看到的工作区版本。
 * 其他页面/系统先完成保存后 revision 已递增，后一次整包保存因
 * expectedRevision 失配被拒绝，避免覆盖别人刚完成的任务与审计。
 */
function assertRevision(state: WorkspaceState, expectedRevision: number): void {
  if (state.revision !== expectedRevision) {
    throw new VersionConflictError(
      `${VERSION_CONFLICT_MESSAGE}（当前版本 ${state.revision}，提交基于版本 ${expectedRevision}）`,
    )
  }
}

export class VersionConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VersionConflictError'
  }
}

function mutateRequest(
  state: WorkspaceState,
  expectedRevision: number,
  requestId: string,
  mutation: (request: PrivacyRequest, draft: WorkspaceState) => void,
  audit: { action: string; operator: string; detail: string },
): WorkspaceState {
  assertRevision(state, expectedRevision)
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  mutation(request, draft)
  appendAudit(draft, request, audit.action, audit.operator, audit.detail)
  draft.revision += 1
  draft.schemaVersion = WORKSPACE_SCHEMA_VERSION
  return draft
}

/** 存在未复核冲突或身份阻断时，状态回到复核队列。 */
function recomputeStatus(request: PrivacyRequest, fallback: RequestStatus): RequestStatus {
  if (request.conflicts.some((conflict) => !conflict.resolved)) return 'review-required'
  return fallback
}

export interface CreateRequestInput {
  requesterName: string
  requesterContact: string
  region: Region
  type: RequestType
  affectedSystemIds: string[]
  identityMaterialType: IdentityCheck['materialType']
  identityReference: string
  note: string
}

export function createRequest(
  state: WorkspaceState,
  input: CreateRequestInput,
  operator: string,
  expectedRevision: number,
): WorkspaceState {
  assertRevision(state, expectedRevision)
  const draft = cloneState(state)
  const requestedAt = now()
  // 期限模板在登记瞬间冻结，后续模板改版只影响之后登记的请求。
  const template = freezeTemplate(input.region, requestedAt)
  const dueAt = addDays(new Date(requestedAt), template.responseDays).toISOString()
  const duplicate = draft.requests.find(
    (request) =>
      request.requesterContact === input.requesterContact &&
      request.type === input.type &&
      !['completed', 'rejected'].includes(request.status),
  )
  const identityInsufficient =
    input.identityMaterialType === 'none' || input.identityReference.trim().length < 6
  const status: RequestStatus = identityInsufficient || duplicate ? 'review-required' : 'identity-review'
  const nextNumber =
    Math.max(
      0,
      ...draft.requests.map((request) => Number(request.code.split('-').at(-1)) || 0),
    ) + 1
  const requestId = id('request')
  const request: PrivacyRequest = {
    id: requestId,
    code: `DSR-2026-${String(nextNumber).padStart(3, '0')}`,
    requesterName: input.requesterName.trim(),
    requesterContact: input.requesterContact.trim(),
    region: input.region,
    type: input.type,
    status,
    identity: {
      status: identityInsufficient ? 'insufficient' : 'pending',
      materialType: input.identityMaterialType,
      maskedReference: input.identityReference.trim(),
      protectedDigest: digest(input.identityReference),
      note: input.note.trim(),
    },
    requestedAt,
    dueAt,
    deadlineTemplate: template,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    extendedDays: 0,
    duplicateOf: duplicate?.code,
    affectedSystemIds: [...input.affectedSystemIds],
    tasks: buildWorkflowSteps({
      requestId,
      type: input.type,
      systemIds: input.affectedSystemIds,
      requestedAt,
      dueAt,
      initialStatus: 'identity-review',
      systems: draft.systems,
    }),
    evidence: [],
    conflicts: [],
    receipts: [],
    resultSummary: '',
    closureReason: '',
    audit: [],
  }
  if (identityInsufficient) {
    request.conflicts.push({
      id: id('conflict'),
      description: '身份材料不足：需要补充可核验的身份或授权关系证明。',
      raisedAt: requestedAt,
      resolved: false,
    })
    const identityTask = request.tasks.find((task) => task.id.endsWith('-identity'))
    if (identityTask) {
      identityTask.status = 'blocked'
      identityTask.exceptionReason = '身份材料不足，等待复核。'
    }
  }
  if (duplicate) {
    request.conflicts.push({
      id: id('conflict'),
      description: `疑似重复请求：与 ${duplicate.code} 的请求人和请求类型相同。`,
      raisedAt: requestedAt,
      resolved: false,
    })
  }
  draft.requests.unshift(request)
  appendAudit(
    draft,
    request,
    '登记隐私请求',
    operator,
    `按冻结模板 ${template.version}（${regionLabels[input.region]} ${template.responseDays} 日）登记，涉及 ${input.affectedSystemIds.length} 个系统；模板改版不影响本请求期限。`,
    requestedAt,
  )
  draft.revision += 1
  draft.schemaVersion = WORKSPACE_SCHEMA_VERSION
  return draft
}

export function saveRequest(
  state: WorkspaceState,
  expectedRevision: number,
  requestId: string,
  patch: Partial<Pick<PrivacyRequest, 'requesterName' | 'requesterContact'>>,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    expectedRevision,
    requestId,
    (request) => {
      // 整包保存只允许更新基本联系信息；地区/类型/系统与冻结期限一律不接受覆盖。
      if (patch.requesterName !== undefined) request.requesterName = patch.requesterName.trim()
      if (patch.requesterContact !== undefined) {
        request.requesterContact = patch.requesterContact.trim()
      }
    },
    { action: '更新请求信息', operator, detail: '更新请求人或联系方式；冻结期限模板、任务与回执不受影响。' },
  )
}

export function verifyIdentity(
  state: WorkspaceState,
  expectedRevision: number,
  requestId: string,
  status: 'verified' | 'insufficient',
  note: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    expectedRevision,
    requestId,
    (request) => {
      request.identity.status = status
      request.identity.note = note
      request.identity.reviewedAt = now()
      request.identity.reviewedBy = operator
      const identityTask = request.tasks.find((task) => task.id.endsWith('-identity'))
      if (status === 'verified') {
        if (identityTask) {
          identityTask.status = 'completed'
          identityTask.completedAt = now()
          identityTask.exceptionReason = ''
        }
        request.conflicts = request.conflicts.filter(
          (conflict) => !conflict.description.startsWith('身份材料不足'),
        )
        const nextTask = request.tasks.find((task) => task.status === 'pending')
        if (nextTask) nextTask.status = 'active'
        request.status = recomputeStatus(request, 'processing')
      } else {
        if (identityTask) {
          identityTask.status = 'blocked'
          identityTask.exceptionReason = note
        }
        request.status = 'review-required'
        if (!request.conflicts.some((conflict) => conflict.description.startsWith('身份材料不足'))) {
          request.conflicts.push({
            id: id('conflict'),
            description: `身份材料不足：${note}`,
            raisedAt: now(),
            resolved: false,
          })
        }
      }
    },
    {
      action: status === 'verified' ? '身份核验通过' : '身份材料退回',
      operator,
      detail: note,
    },
  )
}

export function assignTask(
  state: WorkspaceState,
  expectedRevision: number,
  requestId: string,
  taskId: string,
  assignee: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    expectedRevision,
    requestId,
    (request) => {
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      task.assignee = assignee
    },
    { action: '分派履约任务', operator, detail: `任务 ${taskId} 分派给 ${assignee}。` },
  )
}

export function taskAction(
  state: WorkspaceState,
  expectedRevision: number,
  requestId: string,
  taskId: string,
  action: 'start' | 'complete' | 'block',
  note: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    expectedRevision,
    requestId,
    (request) => {
      if (request.identity.status !== 'verified') {
        throw new Error('身份未核验通过，不能推进履约任务')
      }
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      if (action === 'start') {
        task.status = 'active'
        task.exceptionReason = ''
      } else if (action === 'complete') {
        // 执行任务以系统回执为准完成；没有回执时允许人工完成但会在合并前再次校验。
        task.status = 'completed'
        task.completedAt = now()
        task.exceptionReason = ''
        const nextTask = request.tasks.find((item) => item.status === 'pending')
        if (nextTask) nextTask.status = 'active'
      } else {
        task.status = 'blocked'
        task.exceptionReason = note
        request.conflicts.push({
          id: id('conflict'),
          description: `任务阻塞：${task.name}，${note}`,
          raisedAt: now(),
          resolved: false,
        })
      }
      if (action === 'block') {
        request.status = 'review-required'
      } else if (request.conflicts.some((conflict) => !conflict.resolved)) {
        request.status = 'review-required'
      } else {
        request.status = 'processing'
      }
    },
    {
      action:
        action === 'start' ? '开始履约任务' : action === 'complete' ? '完成履约任务' : '阻断履约任务',
      operator,
      detail: note || `${taskId} 状态更新为 ${action}。`,
    },
  )
}

export function addEvidence(
  state: WorkspaceState,
  expectedRevision: number,
  requestId: string,
  taskId: string,
  name: string,
  evidenceType: 'execution-log' | 'screenshot' | 'signed-record' | 'system-response',
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    expectedRevision,
    requestId,
    (request) => {
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      request.evidence.push({
        id: id('evidence'),
        stepId: taskId,
        name,
        evidenceType,
        digest: digest(`${name}-${now()}`),
        uploadedBy: operator,
        uploadedAt: now(),
        protected: true,
      })
    },
    {
      action: '上传执行证据',
      operator,
      detail: `${name} 已按受保护附件登记，保存摘要而非明文材料。`,
    },
  )
}

export interface RegisterReceiptInput {
  systemId: string
  idempotencyKey: string
  outcome: 'success' | 'conflict'
  payloadSummary: string
  note: string
  isResend: boolean
}

export interface RegisterReceiptResult {
  state: WorkspaceState
  /** duplicate=true 表示该回执此前已接受过，本次按同一笔重发处理，未生成新证据。 */
  duplicate: boolean
  receipt: SystemReceipt
}

/**
 * 登记跨系统处理回执：
 * - 首次收到：接受并只生成一份证据、完成执行任务；
 * - 超时重发（幂等键相同，或同系统已有接受回执）：按同一笔认，仅追加重发尝试，
 *   不重复生成证据、不改变任务完成时间；
 * - 回执声明冲突：建立/更新冲突回执并挂未复核冲突，请求进入复核队列。
 */
export function registerReceipt(
  state: WorkspaceState,
  expectedRevision: number,
  requestId: string,
  input: RegisterReceiptInput,
  operator: string,
): RegisterReceiptResult {
  assertRevision(state, expectedRevision)
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  if (request.identity.status !== 'verified') {
    throw new Error('身份未核验通过，不能登记系统回执')
  }
  if (!request.affectedSystemIds.includes(input.systemId)) {
    throw new Error('该系统不在本请求的处理范围内')
  }
  const task = request.tasks.find(
    (item) => item.systemId === input.systemId && item.id.includes('-execute-'),
  )
  if (!task) throw new Error('该系统的执行任务不存在')

  const receivedAt = now()
  const existingByKey = request.receipts?.find(
    (receipt) => receipt.idempotencyKey === input.idempotencyKey,
  )
  const existingBySystem = request.receipts?.find(
    (receipt) => receipt.systemId === input.systemId && receipt.status === 'accepted',
  )
  const existing = existingByKey ?? existingBySystem

  // 重复回执：超时重发按同一笔认，只追加尝试记录。
  if (existing) {
    existing.attempts.push({
      id: id('attempt'),
      kind: input.outcome === 'conflict' ? 'conflict' : 'resent',
      operator,
      receivedAt,
      note: input.note || (input.isResend ? '超时后重发，沿用首次接受回执。' : '重复送达，按同一笔回执处理。'),
    })
    // 重发回执若声明冲突，追加未复核冲突，但首次回执与证据保持不变。
    if (input.outcome === 'conflict') {
      request.conflicts.push({
        id: id('conflict'),
        description: `系统 ${input.systemId} 在重发回执中声明结果冲突：${input.payloadSummary}`,
        raisedAt: receivedAt,
        resolved: false,
      })
      request.status = 'review-required'
    }
    appendAudit(
      draft,
      request,
      '重发系统回执（同一笔）',
      operator,
      `${task.name} 回执 ${input.idempotencyKey} 与已接受回执 ${existing.idempotencyKey} 属同一笔，仅记为重发尝试，未重复生成证据。`,
      receivedAt,
    )
    draft.revision += 1
    draft.schemaVersion = WORKSPACE_SCHEMA_VERSION
    return { state: draft, duplicate: true, receipt: existing }
  }

  const accepted = input.outcome === 'success'
  const receipt: SystemReceipt = {
    id: id('receipt'),
    systemId: input.systemId,
    taskId: task.id,
    idempotencyKey: input.idempotencyKey,
    status: accepted ? 'accepted' : 'conflict',
    operator,
    receivedAt,
    payloadSummary: input.payloadSummary,
    receiptDigest: digest(`${input.idempotencyKey}-${input.systemId}`),
    attempts: [
      {
        id: id('attempt'),
        kind: accepted ? 'accepted' : 'conflict',
        operator,
        receivedAt,
        note: input.note || (accepted ? '首次送达，回执被接受。' : '回执声明处理结果冲突。'),
      },
    ],
  }
  request.receipts = request.receipts ?? []
  request.receipts.push(receipt)

  // 首次接受才生成证据，并完成执行任务；重复/冲突路径不生成证据。
  if (accepted) {
    request.evidence.push({
      id: id('evidence'),
      stepId: task.id,
      name: `${task.name} 系统回执`,
      evidenceType: 'system-response',
      digest: receipt.receiptDigest,
      uploadedBy: operator,
      uploadedAt: receivedAt,
      protected: true,
      receiptKey: input.idempotencyKey,
    })
    task.status = 'completed'
    task.completedAt = receivedAt
    task.exceptionReason = ''
    const locateTask = request.tasks.find(
      (item) => item.systemId === input.systemId && item.id.includes('-locate-'),
    )
    if (locateTask && locateTask.status !== 'completed') {
      locateTask.status = 'completed'
      locateTask.completedAt = receivedAt
      locateTask.exceptionReason = ''
    }
  } else {
    request.conflicts.push({
      id: id('conflict'),
      description: `系统 ${input.systemId} 回执与其他系统结果冲突：${input.payloadSummary}`,
      raisedAt: receivedAt,
      resolved: false,
    })
  }

  // 回执不自动合并：只反映处理进度，是否待合并由 receipts 到齐情况驱动。
  if (accepted && !request.conflicts.some((conflict) => !conflict.resolved)) {
    request.status = 'processing'
  } else {
    request.status = 'review-required'
  }

  appendAudit(
    draft,
    request,
    accepted ? '接受系统回执' : '回执标记跨系统冲突',
    operator,
    `${task.name} 回执 ${input.idempotencyKey} ${accepted ? '被接受，生成一份回执证据' : '声明结果冲突，进入复核队列'}。`,
    receivedAt,
  )
  draft.revision += 1
  draft.schemaVersion = WORKSPACE_SCHEMA_VERSION
  return { state: draft, duplicate: false, receipt }
}

/** 跨系统回执是否全部到齐（每个涉及系统一份已接受回执）。 */
export function receiptsComplete(request: PrivacyRequest): boolean {
  const acceptedSystems = new Set(
    (request.receipts ?? [])
      .filter((receipt) => receipt.status === 'accepted')
      .map((receipt) => receipt.systemId),
  )
  return request.affectedSystemIds.every((systemId) => acceptedSystems.has(systemId))
}

/** 当前请求卡在哪些系统：尚未有已接受回执的系统（含冲突未消解）。 */
export function pendingSystems(request: PrivacyRequest): string[] {
  const acceptedSystems = new Set(
    (request.receipts ?? [])
      .filter((receipt) => receipt.status === 'accepted')
      .map((receipt) => receipt.systemId),
  )
  return request.affectedSystemIds.filter((systemId) => !acceptedSystems.has(systemId))
}

/**
 * 合并跨系统结果：必须全部系统回执到齐才允许执行。
 * 合并只基于各系统已接受回执，不接受任何系统的整包覆盖。
 */
export function mergeResults(
  state: WorkspaceState,
  expectedRevision: number,
  requestId: string,
  note: string,
  operator: string,
): WorkspaceState {
  assertRevision(state, expectedRevision)
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')

  const missing = pendingSystems(request)
  if (missing.length) {
    throw new Error(`仍有 ${missing.length} 个系统回执未到齐，不能合并跨系统结果`)
  }
  if (request.conflicts.some((conflict) => !conflict.resolved)) {
    throw new Error('仍有未复核冲突，不能合并跨系统结果')
  }

  const mergedAt = now()
  const acceptedReceipts = (request.receipts ?? []).filter(
    (receipt) => receipt.status === 'accepted',
  )
  request.merge = {
    mergedAt,
    mergedBy: operator,
    note,
    receiptIds: acceptedReceipts.map((receipt) => receipt.id),
  }
  const mergeTask = request.tasks.find((task) => task.id.endsWith('-merge'))
  if (mergeTask) {
    mergeTask.status = 'completed'
    mergeTask.completedAt = mergedAt
    mergeTask.exceptionReason = ''
  }
  const reviewTask = request.tasks.find((task) => task.id.endsWith('-review'))
  if (reviewTask && reviewTask.status === 'pending') reviewTask.status = 'active'

  request.status = 'pending-close'
  appendAudit(
    draft,
    request,
    '合并跨系统结果',
    operator,
    `已到齐 ${acceptedReceipts.length} 个系统回执并完成合并：${note}`,
    mergedAt,
  )
  draft.revision += 1
  draft.schemaVersion = WORKSPACE_SCHEMA_VERSION
  return draft
}

export function addConflict(
  state: WorkspaceState,
  expectedRevision: number,
  requestId: string,
  conflict: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    expectedRevision,
    requestId,
    (request) => {
      const record: ConflictRecord = {
        id: id('conflict'),
        description: conflict,
        raisedAt: now(),
        resolved: false,
      }
      request.conflicts.push(record)
      request.status = 'review-required'
    },
    { action: '标记冲突或例外', operator, detail: conflict },
  )
}

export function resolveConflict(
  state: WorkspaceState,
  expectedRevision: number,
  requestId: string,
  conflictId: string,
  resolution: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    expectedRevision,
    requestId,
    (request) => {
      const conflict = request.conflicts.find((item) => item.id === conflictId)
      if (!conflict) throw new Error('冲突项不存在')
      conflict.resolved = true
      conflict.resolution = resolution
      conflict.resolvedBy = operator
      conflict.resolvedAt = now()
      // 全部冲突复核完毕后：已合并则待关闭，否则继续处理。
      if (request.conflicts.every((item) => item.resolved)) {
        request.status = request.merge ? 'pending-close' : 'processing'
      } else {
        request.status = 'review-required'
      }
    },
    { action: '复核处理冲突', operator, detail: resolution },
  )
}

export function extendRequest(
  state: WorkspaceState,
  expectedRevision: number,
  requestId: string,
  days: number,
  reason: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    expectedRevision,
    requestId,
    (request) => {
      const base = new Date(request.dueAt) > new Date() ? new Date(request.dueAt) : new Date()
      request.dueAt = addDays(base, days).toISOString()
      request.extendedDays += days
      request.status = 'extended'
    },
    { action: '延期请求处理', operator, detail: `延期 ${days} 天：${reason}` },
  )
}

export function closeRequest(
  state: WorkspaceState,
  expectedRevision: number,
  requestId: string,
  resultSummary: string,
  closureReason: string,
  operator: string,
): WorkspaceState {
  assertRevision(state, expectedRevision)
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  if (request.identity.status !== 'verified') {
    throw new Error('身份核验尚未通过，不能关闭请求')
  }
  const requiredTasks = request.tasks.filter((task) => !task.id.endsWith('-close'))
  if (requiredTasks.some((task) => task.status !== 'completed')) {
    throw new Error('仍有未完成任务，不能关闭请求')
  }
  // 跨系统回执必须全部接受并已完成合并。
  if (!receiptsComplete(request)) {
    throw new Error('跨系统回执尚未全部到齐，不能关闭请求')
  }
  if (!request.merge) {
    throw new Error('跨系统结果尚未合并，不能关闭请求')
  }
  // 冲突没复核前不能关闭。
  const unresolved = request.conflicts.filter((conflict) => !conflict.resolved)
  if (unresolved.length) {
    throw new Error(`仍有 ${unresolved.length} 项冲突未复核，不能关闭请求`)
  }
  if (new Date(request.dueAt) > new Date() && !closureReason.trim()) {
    throw new Error('截止时间前关闭必须填写提前关闭理由')
  }

  const closedAt = now()
  request.resultSummary = resultSummary
  request.closureReason = closureReason
  request.status = 'completed'
  const closeTask = request.tasks.find((task) => task.id.endsWith('-close'))
  if (closeTask) {
    closeTask.status = 'completed'
    closeTask.completedAt = closedAt
    closeTask.exceptionReason = ''
  }
  appendAudit(
    draft,
    request,
    '完成并关闭请求',
    operator,
    closureReason ? `提前关闭理由：${closureReason}` : '截止时间后完成关闭。',
    closedAt,
  )
  draft.revision += 1
  draft.schemaVersion = WORKSPACE_SCHEMA_VERSION
  return draft
}

export function addComment(
  state: WorkspaceState,
  expectedRevision: number,
  requestId: string,
  content: string,
  operator: string,
): WorkspaceState {
  assertRevision(state, expectedRevision)
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  draft.comments.unshift({
    id: id('comment'),
    requestId,
    author: operator,
    content,
    createdAt: now(),
  })
  appendAudit(draft, request, '提交处理意见', operator, content)
  draft.revision += 1
  draft.schemaVersion = WORKSPACE_SCHEMA_VERSION
  return draft
}

export function recordExport(
  state: WorkspaceState,
  expectedRevision: number,
  scope: string,
  count: number,
  operator: string,
): WorkspaceState {
  assertRevision(state, expectedRevision)
  const draft = cloneState(state)
  draft.audit.unshift({
    id: id('audit'),
    action: '导出处理包',
    operator,
    detail: `导出范围：${scope}，包含 ${count} 条请求。`,
    createdAt: now(),
  })
  draft.revision += 1
  draft.schemaVersion = WORKSPACE_SCHEMA_VERSION
  return draft
}
