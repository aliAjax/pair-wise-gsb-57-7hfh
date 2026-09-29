import type {
  IdentityCheck,
  PrivacyRequest,
  RequestStatus,
  RequestType,
  SystemReceipt,
  WorkspaceState,
} from '@/types/domain'
import { addDays, buildWorkflowSteps, freezeDeadlineTemplate, receiptStatus, responseDays } from './workflow'

const cloneState = (state: WorkspaceState): WorkspaceState => structuredClone(state)
const now = () => new Date().toISOString()
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

/** 处理动作绑定的版本与请求当前版本不一致（旧页面整包保存）时抛出 */
export class StaleVersionError extends Error {
  constructor(expected: number, current: number) {
    super(`版本冲突：该动作绑定 v${expected}，请求已被其他页面或系统更新到 v${current}，请刷新后基于当前版本重试。`)
    this.name = 'StaleVersionError'
  }
}

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

interface AuditSpec {
  action: string
  operator: string
  detail: string | ((request: PrivacyRequest) => string)
}

function mutateRequest(
  state: WorkspaceState,
  requestId: string,
  expectedVersion: number,
  mutation: (request: PrivacyRequest, draft: WorkspaceState) => AuditSpec | void,
  fallbackAudit?: AuditSpec,
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  if (request.version !== expectedVersion) {
    throw new StaleVersionError(expectedVersion, request.version)
  }
  const auditOverride = mutation(request, draft) ?? fallbackAudit
  if (auditOverride) {
    const detail =
      typeof auditOverride.detail === 'function'
        ? auditOverride.detail(request)
        : auditOverride.detail
    appendAudit(draft, request, auditOverride.action, auditOverride.operator, detail)
  }
  request.version += 1
  draft.revision += 1
  return draft
}

export interface CreateRequestInput {
  requesterName: string
  requesterContact: string
  region: keyof typeof responseDays
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
): WorkspaceState {
  const draft = cloneState(state)
  const requestedAt = now()
  // 期限按登记时的地区模板冻结：响应天数与模板版本一起快照到请求上
  const template = freezeDeadlineTemplate(input.region, requestedAt)
  const dueAt = addDays(new Date(requestedAt), template.days).toISOString()
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
    version: 0,
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
    systemReceipts: [],
    conflicts: [],
    resultSummary: '',
    closureReason: '',
    audit: [],
  }
  if (identityInsufficient) {
    request.conflicts.push('身份材料不足：需要补充可核验的身份或授权关系证明。')
    const identityTask = request.tasks.find((task) => task.id.endsWith('-identity'))
    if (identityTask) {
      identityTask.status = 'blocked'
      identityTask.exceptionReason = '身份材料不足，等待复核。'
    }
  }
  if (duplicate) {
    request.conflicts.push(`疑似重复请求：与 ${duplicate.code} 的请求人和请求类型相同。`)
  }
  draft.requests.unshift(request)
  appendAudit(
    draft,
    request,
    '登记隐私请求',
    operator,
    `按 ${template.templateVersion} 版 ${regionTemplateLabel(input.region)} ${template.days} 日期限模板登记并冻结期限，涉及 ${input.affectedSystemIds.length} 个系统；新模板不再影响本请求。`,
    requestedAt,
  )
  request.version = 1
  draft.revision += 1
  return draft
}

function regionTemplateLabel(region: keyof typeof responseDays): string {
  const labels: Record<keyof typeof responseDays, string> = {
    cn: '中国大陆',
    eu: '欧盟',
    us: '美国加州',
    sg: '新加坡',
  }
  return labels[region]
}

export function saveRequest(
  state: WorkspaceState,
  requestId: string,
  expectedVersion: number,
  patch: Partial<Pick<PrivacyRequest, 'requesterName' | 'requesterContact'>>,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    expectedVersion,
    (request) => {
      // 基本信息更新走白名单，整包保存不得覆盖任务、证据、回执、审计和冻结模板
      if (patch.requesterName !== undefined) request.requesterName = patch.requesterName
      if (patch.requesterContact !== undefined) request.requesterContact = patch.requesterContact
    },
    { action: '更新请求信息', operator, detail: '更新请求人或联系方式；地区、类型、系统与期限模板保持登记时冻结值。' },
  )
}

export function verifyIdentity(
  state: WorkspaceState,
  requestId: string,
  expectedVersion: number,
  status: 'verified' | 'insufficient',
  note: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    expectedVersion,
    (request) => {
      request.identity.status = status
      request.identity.note = note
      request.identity.reviewedAt = now()
      const identityTask = request.tasks.find((task) => task.id.endsWith('-identity'))
      if (status === 'verified') {
        if (identityTask) {
          identityTask.status = 'completed'
          identityTask.completedAt = now()
          identityTask.exceptionReason = ''
        }
        request.conflicts = request.conflicts.filter(
          (conflict) => !conflict.startsWith('身份材料不足'),
        )
        const nextTask = request.tasks.find((task) => task.status === 'pending')
        if (nextTask) nextTask.status = 'active'
        request.status = request.conflicts.length ? 'review-required' : 'processing'
      } else {
        if (identityTask) {
          identityTask.status = 'blocked'
          identityTask.exceptionReason = note
        }
        request.status = 'review-required'
        if (!request.conflicts.some((conflict) => conflict.startsWith('身份材料不足'))) {
          request.conflicts.push(`身份材料不足：${note}`)
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
  requestId: string,
  expectedVersion: number,
  taskId: string,
  assignee: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    expectedVersion,
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
  requestId: string,
  expectedVersion: number,
  taskId: string,
  action: 'start' | 'complete' | 'block',
  note: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    expectedVersion,
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
        if (task.id.endsWith('-merge')) {
          // 跨系统回执全部到齐后才允许合并，防止先合并后盖掉其他系统结果
          const status = receiptStatus(request)
          if (!status.allAccepted) {
            throw new Error(
              `仍有 ${status.waitingSystems.length} 个系统回执未到齐，不能合并跨系统结果`,
            )
          }
        }
        if (task.id.endsWith('-review') && request.conflicts.length) {
          throw new Error('冲突未复核完成，不能完成复核步骤')
        }
        task.status = 'completed'
        task.completedAt = now()
        task.exceptionReason = ''
        const nextTask = request.tasks.find((item) => item.status === 'pending')
        if (nextTask) nextTask.status = 'active'
      } else {
        task.status = 'blocked'
        task.exceptionReason = note
        request.status = 'review-required'
        request.conflicts.push(`任务阻塞：${task.name}，${note}`)
      }
      const executableTasks = request.tasks.filter((item) => !item.id.endsWith('-close'))
      if (executableTasks.every((item) => item.status === 'completed')) {
        request.status = 'pending-close'
      } else if (action !== 'block') {
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
  requestId: string,
  expectedVersion: number,
  taskId: string,
  name: string,
  evidenceType: 'execution-log' | 'screenshot' | 'signed-record' | 'system-response',
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    expectedVersion,
    (request) => {
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      request.evidence.push({
        id: id('evidence'),
        stepId: taskId,
        name,
        evidenceType,
        digest: digest(`${name}-${taskId}-${now()}`),
        uploadedBy: operator,
        uploadedAt: now(),
        protected: true,
        source: 'manual',
      })
    },
    {
      action: '上传执行证据',
      operator,
      detail: `${name} 已按受保护附件登记，保存摘要而非明文材料。`,
    },
  )
}

export interface RegisterReceiptResult {
  receipt: SystemReceipt
  duplicated: boolean
}

/**
 * 登记跨系统处理回执（含超时重发）。
 * 同一 (systemId, receiptKey) 视为同一笔：首次接受会生成证据并推进系统任务；
 * 重发只追加投递记录，不重复生成证据、不重复推进任务。
 */
export function registerSystemReceipt(
  state: WorkspaceState,
  requestId: string,
  expectedVersion: number,
  systemId: string,
  receiptKey: string,
  result: 'accepted' | 'failed',
  summary: string,
  note: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    expectedVersion,
    (request, draft) => {
      if (!request.affectedSystemIds.includes(systemId)) {
        throw new Error('该系统不在本请求涉及系统范围内')
      }
      if (request.identity.status !== 'verified') {
        throw new Error('身份未核验通过，不能登记系统回执')
      }
      const system = draft.systems.find((item) => item.id === systemId)
      const systemName = system?.name ?? systemId
      const existing = request.systemReceipts.find(
        (item) => item.systemId === systemId && item.receiptKey === receiptKey,
      )
      const deliveredAt = now()

      if (existing) {
        // 同一笔回执的超时重发：幂等确认，仅留痕
        existing.redeliveries.push({
          deliveredAt,
          operator,
          note: note || `回执 ${receiptKey} 超时重发，按同一笔回执确认。`,
        })
        existing.lastDeliveryAt = deliveredAt
        existing.deliveryCount += 1
        return {
          action: '系统回执重发（按同一笔确认）',
          operator,
          detail: `${systemName} 回执 ${receiptKey} 第 ${existing.deliveryCount} 次送达，与首次接受为同一笔：不重复生成证据、不重复推进任务。`,
        }
      }

      const receipt: SystemReceipt = {
        id: id('receipt'),
        systemId,
        receiptKey,
        status: result,
        summary,
        receivedAt: deliveredAt,
        lastDeliveryAt: deliveredAt,
        deliveryCount: 1,
        operator,
        redeliveries: [],
      }

      if (result === 'accepted') {
        // 首次接受：为该系统生成唯一一份回执证据，并完成定位/执行任务
        request.evidence.push({
          id: id('evidence'),
          stepId: `${request.id}-execute-${systemId}`,
          name: `${systemName}处理回执（${receiptKey}）`,
          evidenceType: 'system-response',
          digest: digest(`${request.id}-${systemId}-${receiptKey}`),
          uploadedBy: operator,
          uploadedAt: deliveredAt,
          protected: true,
          receiptKey,
          source: 'receipt',
        })
        for (const task of request.tasks) {
          if (
            task.systemId === systemId &&
            (task.id.includes('-locate-') || task.id.includes('-execute-')) &&
            task.status !== 'completed'
          ) {
            task.status = 'completed'
            task.completedAt = deliveredAt
            task.exceptionReason = ''
          }
        }
      } else {
        const conflictText = `系统回执例外：${systemName} 回执 ${receiptKey} 返回失败——${summary}`
        receipt.conflict = conflictText
        request.conflicts.push(conflictText)
        const executeTask = request.tasks.find(
          (task) => task.systemId === systemId && task.id.includes('-execute-'),
        )
        if (executeTask && executeTask.status !== 'completed') {
          executeTask.status = 'blocked'
          executeTask.exceptionReason = summary
        }
        request.status = 'review-required'
      }

      request.systemReceipts.push(receipt)

      const status = receiptStatus(request)
      if (result === 'accepted') {
        if (status.allAccepted) {
          // 全部系统回执到齐：激活合并步骤，等待人工合并
          const mergeTask = request.tasks.find((task) => task.id.endsWith('-merge'))
          if (mergeTask && mergeTask.status === 'pending') mergeTask.status = 'active'
          if (!request.conflicts.length) request.status = 'processing'
        } else if (!request.conflicts.length) {
          request.status = 'processing'
        }
      }

      return {
        action: result === 'accepted' ? '接受系统处理回执' : '系统回执失败进入复核',
        operator,
        detail:
          result === 'accepted'
            ? `接受 ${systemName} 回执 ${receiptKey}：${summary}。回执到齐 ${status.acceptedSystemIds.length}/${request.affectedSystemIds.length}${status.allAccepted ? '，已激活跨系统结果合并。' : `，等待 ${status.waitingSystems.length} 个系统。`}`
            : `${systemName} 回执 ${receiptKey} 返回失败：${summary}，冲突未复核前不能关闭。`,
      }
    },
  )
}

export function addConflict(
  state: WorkspaceState,
  requestId: string,
  expectedVersion: number,
  conflict: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    expectedVersion,
    (request) => {
      request.conflicts.push(conflict)
      request.status = 'review-required'
    },
    { action: '标记冲突或例外', operator, detail: conflict },
  )
}

export function resolveConflict(
  state: WorkspaceState,
  requestId: string,
  expectedVersion: number,
  conflictIndex: number,
  resolution: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    expectedVersion,
    (request) => {
      const conflict = request.conflicts[conflictIndex]
      if (!conflict) throw new Error('冲突项不存在')
      request.conflicts.splice(conflictIndex, 1)
      if (!request.conflicts.length && request.identity.status === 'verified') {
        // 回执到齐且冲突清空后才回到待合并/处理中，冲突未复核前保持复核状态、禁止关闭
        const status = receiptStatus(request)
        request.status = status.allAccepted ? 'processing' : 'review-required'
      } else {
        request.status = 'review-required'
      }
    },
    { action: '复核处理冲突', operator, detail: resolution },
  )
}

export function extendRequest(
  state: WorkspaceState,
  requestId: string,
  expectedVersion: number,
  days: number,
  reason: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    expectedVersion,
    (request) => {
      const base = new Date(request.dueAt) > new Date() ? new Date(request.dueAt) : new Date()
      request.dueAt = addDays(base, days).toISOString()
      request.extendedDays += days
      request.status = 'extended'
    },
    {
      action: '延期请求处理',
      operator,
      detail: (request) =>
        `在冻结模板（${request.deadlineTemplate.templateVersion}，${request.deadlineTemplate.days} 日）基础上延期 ${days} 天：${reason}`,
    },
  )
}

export function closeRequest(
  state: WorkspaceState,
  requestId: string,
  expectedVersion: number,
  resultSummary: string,
  closureReason: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    expectedVersion,
    (request) => {
      if (request.identity.status !== 'verified') {
        throw new Error('身份核验尚未通过，不能关闭请求')
      }
      const requiredTasks = request.tasks.filter((task) => !task.id.endsWith('-close'))
      if (requiredTasks.some((task) => task.status !== 'completed')) {
        throw new Error('仍有未完成任务，不能关闭请求')
      }
      if (request.conflicts.length) {
        throw new Error('仍有未复核冲突，不能关闭请求')
      }
      const status = receiptStatus(request)
      if (!status.allAccepted) {
        throw new Error('跨系统回执未全部到齐，不能合并关闭')
      }
      if (new Date(request.dueAt) > new Date() && !closureReason.trim()) {
        throw new Error('截止时间前关闭必须填写提前关闭理由')
      }
      request.resultSummary = resultSummary
      request.closureReason = closureReason
      request.status = 'completed'
      const closeTask = request.tasks.find((task) => task.id.endsWith('-close'))
      if (closeTask) {
        closeTask.status = 'completed'
        closeTask.completedAt = now()
      }
    },
    {
      action: '完成并关闭请求',
      operator,
      detail: closureReason ? `提前关闭理由：${closureReason}` : '截止时间后完成关闭。',
    },
  )
}

export function addComment(
  state: WorkspaceState,
  requestId: string,
  expectedVersion: number,
  content: string,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  if (request.version !== expectedVersion) {
    throw new StaleVersionError(expectedVersion, request.version)
  }
  const createdAt = now()
  draft.comments.unshift({
    id: id('comment'),
    requestId,
    author: operator,
    content,
    createdAt,
  })
  appendAudit(draft, request, '提交处理意见', operator, content, createdAt)
  request.version += 1
  draft.revision += 1
  return draft
}

export function recordExport(
  state: WorkspaceState,
  scope: string,
  count: number,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  draft.audit.unshift({
    id: id('audit'),
    action: '导出处理包',
    operator,
    detail: `导出范围：${scope}，包含 ${count} 条请求。`,
    createdAt: now(),
  })
  draft.revision += 1
  return draft
}
