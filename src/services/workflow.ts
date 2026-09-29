import type {
  DataSystem,
  DeadlineTemplate,
  Region,
  RequestStatus,
  RequestType,
  WorkflowStep,
} from '@/types/domain'

/**
 * 各地区当前期限模板（带版本）。请求登记时冻结模板版本与天数，
 * 之后这里调整（例如 cn 升到 2026-v2）只影响之后登记的请求；
 * 已登记请求按 deadlineTemplate 快照沿用原期限。
 */
export const regionTemplates: Record<Region, { version: string; responseDays: number }> = {
  cn: { version: '2026-v2', responseDays: 30 },
  eu: { version: '2026-v1', responseDays: 30 },
  us: { version: '2026-v1', responseDays: 45 },
  sg: { version: '2026-v1', responseDays: 30 },
}

export const responseDays = Object.fromEntries(
  Object.entries(regionTemplates).map(([region, template]) => [region, template.responseDays]),
) as Record<Region, number>

/** 登记时冻结当前地区模板。 */
export function freezeTemplate(region: Region, frozenAt = new Date().toISOString()): DeadlineTemplate {
  const template = regionTemplates[region]
  return {
    region,
    version: template.version,
    responseDays: template.responseDays,
    frozenAt,
  }
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

export function buildWorkflowSteps(params: {
  requestId: string
  type: RequestType
  systemIds: string[]
  requestedAt: string
  dueAt: string
  initialStatus: RequestStatus
  systems: DataSystem[]
}): WorkflowStep[] {
  const { requestId, type, systemIds, requestedAt, dueAt, initialStatus, systems } = params
  const steps: WorkflowStep[] = [
    {
      id: `${requestId}-identity`,
      order: 1,
      name: '身份核验与材料保护',
      role: '客服专员',
      status:
        initialStatus === 'registered' || initialStatus === 'identity-review'
          ? 'active'
          : 'completed',
      assignee: '当前客服',
      dueAt,
      completedAt:
        initialStatus === 'registered' || initialStatus === 'identity-review'
          ? undefined
          : requestedAt,
      exceptionReason: '',
    },
  ]

  const applicableSystems = systems.filter((system) => systemIds.includes(system.id))
  systemIds.forEach((systemId, index) => {
    const system = applicableSystems.find((item) => item.id === systemId)
    const isProcessing = ['processing', 'pending-close', 'completed', 'extended'].includes(
      initialStatus,
    )
    steps.push({
      id: `${requestId}-locate-${systemId}`,
      order: steps.length + 1,
      name: `定位 ${system?.name ?? systemId} 数据`,
      role: system?.owner ?? '数据管理员',
      systemId,
      status: isProcessing
        ? initialStatus === 'processing' && index === 0
          ? 'active'
          : ['pending-close', 'completed', 'extended'].includes(initialStatus)
            ? 'completed'
            : 'pending'
        : 'pending',
      assignee: system?.owner ?? '数据管理员',
      dueAt,
      completedAt: ['pending-close', 'completed', 'extended'].includes(initialStatus)
        ? requestedAt
        : undefined,
      exceptionReason: '',
    })
    steps.push({
      id: `${requestId}-execute-${systemId}`,
      order: steps.length + 1,
      name: `${type === 'deletion' ? '执行删除' : type === 'rectification' ? '执行更正' : '执行请求'}：${system?.name ?? systemId}`,
      role: system?.owner ?? '数据管理员',
      systemId,
      status: ['pending-close', 'completed', 'extended'].includes(initialStatus)
        ? 'completed'
        : 'pending',
      assignee: system?.owner ?? '数据管理员',
      dueAt,
      completedAt: ['pending-close', 'completed', 'extended'].includes(initialStatus)
        ? requestedAt
        : undefined,
      exceptionReason: '',
    })
  })

  steps.push(
    {
      id: `${requestId}-merge`,
      order: steps.length + 1,
      name: '合并跨系统处理结果',
      role: '隐私运营',
      status: ['pending-close', 'completed', 'extended'].includes(initialStatus)
        ? 'completed'
        : 'pending',
      assignee: '隐私运营',
      dueAt,
      completedAt: ['pending-close', 'completed', 'extended'].includes(initialStatus)
        ? requestedAt
        : undefined,
      exceptionReason: '',
    },
    {
      id: `${requestId}-review`,
      order: steps.length + 2,
      name: '复核例外、冲突与完整性',
      role: '隐私负责人',
      status: ['pending-close', 'completed', 'extended'].includes(initialStatus)
        ? 'completed'
        : 'pending',
      assignee: '隐私负责人',
      dueAt,
      completedAt: ['pending-close', 'completed', 'extended'].includes(initialStatus)
        ? requestedAt
        : undefined,
      exceptionReason: '',
    },
    {
      id: `${requestId}-close`,
      order: steps.length + 3,
      name: '确认关闭并生成处理包',
      role: '隐私负责人',
      status: initialStatus === 'completed' ? 'completed' : 'pending',
      assignee: '隐私负责人',
      dueAt,
      completedAt: initialStatus === 'completed' ? requestedAt : undefined,
      exceptionReason: '',
    },
  )

  return steps
}

export function templateName(region: Region, type: RequestType, template?: DeadlineTemplate): string {
  const typeNames: Record<RequestType, string> = {
    access: '访问请求',
    rectification: '更正请求',
    deletion: '删除请求',
    'withdraw-consent': '撤回同意',
    restriction: '限制处理',
  }
  const days = template?.responseDays ?? regionTemplates[region].responseDays
  const suffix = template ? `（冻结模板 ${template.version}）` : `（当前模板 ${regionTemplates[region].version}）`
  return `${region.toUpperCase()} · ${typeNames[type]} · ${days} 日流程${suffix}`
}

export function deadlineState(dueAt: string, now = new Date()) {
  const diff = new Date(dueAt).getTime() - now.getTime()
  const days = Math.ceil(diff / 86_400_000)
  if (days < 0) return { label: `已逾期 ${Math.abs(days)} 天`, color: 'red.600', overdue: true }
  if (days <= 3) return { label: `剩余 ${days} 天`, color: 'orange.600', overdue: false }
  return { label: `剩余 ${days} 天`, color: 'green.600', overdue: false }
}
