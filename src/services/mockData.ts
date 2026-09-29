import type { DataSystem, PrivacyRequest, SystemReceipt, WorkspaceState } from '@/types/domain'
import { CURRENT_SCHEMA_VERSION } from '@/lib/schemas'
import { addDays, buildWorkflowSteps, freezeDeadlineTemplate } from './workflow'

const systems: DataSystem[] = [
  {
    id: 'sys-crm',
    name: '客户关系管理系统',
    owner: '客户平台组',
    dataDomain: '客户身份、联系信息、服务记录',
    transferMethod: '受控接口导出',
    slaDays: 5,
    requestTypes: ['access', 'rectification', 'deletion', 'restriction'],
    status: 'active',
  },
  {
    id: 'sys-order',
    name: '订单与交易平台',
    owner: '交易系统组',
    dataDomain: '订单、支付标识、收货信息',
    transferMethod: '离线加密包',
    slaDays: 7,
    requestTypes: ['access', 'deletion'],
    status: 'active',
  },
  {
    id: 'sys-marketing',
    name: '营销自动化平台',
    owner: '增长技术组',
    dataDomain: '同意记录、标签、触达历史',
    transferMethod: '消息队列同步',
    slaDays: 3,
    requestTypes: ['access', 'deletion', 'withdraw-consent', 'restriction'],
    status: 'active',
  },
  {
    id: 'sys-archive',
    name: '电子档案库',
    owner: '档案管理组',
    dataDomain: '合同、凭证、历史记录',
    transferMethod: '双人复核导出',
    slaDays: 10,
    requestTypes: ['access', 'rectification', 'restriction'],
    status: 'maintenance',
  },
  {
    id: 'sys-support',
    name: '客服工单系统',
    owner: '服务运营组',
    dataDomain: '沟通记录、身份核验材料、附件',
    transferMethod: '脱敏下载',
    slaDays: 5,
    requestTypes: ['access', 'rectification', 'deletion', 'restriction'],
    status: 'active',
  },
  {
    id: 'sys-risk',
    name: '风控决策平台',
    owner: '风险技术组',
    dataDomain: '设备指纹、风险标签、决策结果',
    transferMethod: '隔离区核验',
    slaDays: 8,
    requestTypes: ['access', 'rectification', 'restriction'],
    status: 'active',
  },
]

function audit(
  id: string,
  action: string,
  operator: string,
  detail: string,
  createdAt: string,
) {
  return { id, action, operator, detail, createdAt }
}

function receipt(input: Omit<SystemReceipt, 'id'>): SystemReceipt {
  return { id: `receipt-${input.systemId}-${input.receiptKey}`, ...input }
}

/** 把指定系统的定位/执行任务标为已完成 */
function completeSystemTasks(request: PrivacyRequest, systemId: string, completedAt: string) {
  for (const task of request.tasks) {
    if (
      task.systemId === systemId &&
      (task.id.includes('-locate-') || task.id.includes('-execute-'))
    ) {
      task.status = 'completed'
      task.completedAt = completedAt
      task.exceptionReason = ''
    }
  }
}

export function createInitialState(): WorkspaceState {
  const request1At = '2026-09-25T02:30:00.000Z'
  const request2At = '2026-09-18T06:20:00.000Z'
  const request3At = '2026-09-21T03:10:00.000Z'
  const request4At = '2026-09-24T05:40:00.000Z'
  const request5At = '2026-09-05T01:00:00.000Z'
  const request1Due = addDays(new Date(request1At), 30).toISOString()
  const request2Due = addDays(new Date(request2At), 30).toISOString()
  const request3Due = addDays(new Date(request3At), 45).toISOString()
  const request4Due = addDays(new Date(request4At), 30).toISOString()
  const request5Due = addDays(new Date(request5At), 30).toISOString()

  // req-001：CRM 回执已接受（经历过一次超时重发），订单与客服系统回执未到
  const req1CrmReceivedAt = '2026-09-28T07:30:00.000Z'
  const req1CrmRedeliveredAt = '2026-09-29T01:10:00.000Z'
  const request1: PrivacyRequest = {
    id: 'req-001',
    code: 'DSR-2026-001',
    version: 4,
    requesterName: '张晨',
    requesterContact: 'zh***@example.com',
    region: 'cn',
    type: 'access',
    status: 'processing',
    identity: {
      status: 'verified',
      materialType: 'masked-id',
      maskedReference: '310***********1234',
      protectedDigest: 'ID-74A1B2',
      note: '证件影像已核验，原始文件未进入业务库。',
      reviewedAt: '2026-09-25T04:10:00.000Z',
    },
    requestedAt: request1At,
    dueAt: request1Due,
    deadlineTemplate: freezeDeadlineTemplate('cn', request1At),
    extendedDays: 0,
    affectedSystemIds: ['sys-crm', 'sys-order', 'sys-support'],
    tasks: [],
    evidence: [
      {
        id: 'evidence-001-a',
        stepId: 'req-001-identity',
        name: '身份核验记录',
        evidenceType: 'signed-record',
        digest: '9A11-77D2',
        uploadedBy: '当前客服',
        uploadedAt: '2026-09-25T04:10:00.000Z',
        protected: true,
        source: 'manual',
      },
      {
        id: 'evidence-001-b',
        stepId: 'req-001-execute-sys-crm',
        name: '客户关系管理系统处理回执（RCP-CRM-0928-119）',
        evidenceType: 'system-response',
        digest: 'PD-3F82A10C',
        uploadedBy: '客户平台组',
        uploadedAt: req1CrmReceivedAt,
        protected: true,
        receiptKey: 'RCP-CRM-0928-119',
        source: 'receipt',
      },
    ],
    systemReceipts: [
      receipt({
        systemId: 'sys-crm',
        receiptKey: 'RCP-CRM-0928-119',
        status: 'accepted',
        summary: '客户主档、服务记录访问包已生成并加密传输。',
        receivedAt: req1CrmReceivedAt,
        lastDeliveryAt: req1CrmRedeliveredAt,
        deliveryCount: 2,
        operator: '客户平台组',
        redeliveries: [
          {
            deliveredAt: req1CrmRedeliveredAt,
            operator: '系统自动重发',
            note: '回执超时未确认自动重发，与首次为同一笔，仅更新送达状态。',
          },
        ],
      }),
    ],
    conflicts: [],
    resultSummary: '',
    closureReason: '',
    audit: [
      audit(
        'req-audit-001-redelivery',
        '系统回执重发（按同一笔确认）',
        '系统自动重发',
        '客户关系管理系统回执 RCP-CRM-0928-119 第 2 次送达，按同一笔确认，未重复生成证据。',
        req1CrmRedeliveredAt,
      ),
      audit(
        'req-audit-001-receipt',
        '接受系统处理回执',
        '客户平台组',
        '接受客户关系管理系统回执 RCP-CRM-0928-119；回执到齐 1/3，等待 2 个系统。',
        req1CrmReceivedAt,
      ),
      audit(
        'req-audit-001',
        '登记请求',
        '客服专员',
        '访问请求已登记，按 2026-v1 版中国大陆 30 日模板冻结期限。',
        request1At,
      ),
    ],
  }
  request1.tasks = buildWorkflowSteps({
    requestId: 'req-001',
    type: 'access',
    systemIds: ['sys-crm', 'sys-order', 'sys-support'],
    requestedAt: request1At,
    dueAt: request1Due,
    initialStatus: 'processing',
    systems,
  })
  completeSystemTasks(request1, 'sys-crm', req1CrmReceivedAt)
  const locateOrder = request1.tasks.find((task) => task.id === 'req-001-locate-sys-order')
  if (locateOrder) locateOrder.status = 'active'

  const request2: PrivacyRequest = {
    id: 'req-002',
    code: 'DSR-2026-002',
    version: 2,
    requesterName: '王宁',
    requesterContact: 'wa***@example.com',
    region: 'eu',
    type: 'deletion',
    status: 'review-required',
    identity: {
      status: 'insufficient',
      materialType: 'authorization-letter',
      maskedReference: '授权书仅含截图',
      protectedDigest: 'AUTH-11E9',
      note: '缺少委托关系证明，需进入身份材料复核。',
    },
    requestedAt: request2At,
    dueAt: request2Due,
    deadlineTemplate: freezeDeadlineTemplate('eu', request2At),
    extendedDays: 0,
    duplicateOf: 'req-005',
    affectedSystemIds: ['sys-crm', 'sys-marketing', 'sys-support'],
    tasks: buildWorkflowSteps({
      requestId: 'req-002',
      type: 'deletion',
      systemIds: ['sys-crm', 'sys-marketing', 'sys-support'],
      requestedAt: request2At,
      dueAt: request2Due,
      initialStatus: 'review-required',
      systems,
    }),
    evidence: [],
    systemReceipts: [],
    conflicts: [
      '身份材料不足：授权书无法证明申请人与数据主体关系。',
      '疑似重复请求：与 DSR-2026-005 的请求人和处理类型相同。',
    ],
    resultSummary: '',
    closureReason: '',
    audit: [
      audit(
        'req-audit-002',
        '转入复核队列',
        '隐私运营',
        '身份材料不足且检测到疑似重复请求。',
        '2026-09-19T02:00:00.000Z',
      ),
    ],
  }

  const req3CrmAt = '2026-09-28T06:00:00.000Z'
  const req3RiskAt = '2026-09-28T08:30:00.000Z'
  const request3: PrivacyRequest = {
    id: 'req-003',
    code: 'DSR-2026-003',
    version: 4,
    requesterName: '刘晓',
    requesterContact: 'li***@example.com',
    region: 'us',
    type: 'rectification',
    status: 'review-required',
    identity: {
      status: 'verified',
      materialType: 'account-ownership',
      maskedReference: '账号所有权验证通过',
      protectedDigest: 'ACC-559A',
      note: '依据登录挑战与近期交易完成核验。',
      reviewedAt: '2026-09-21T05:30:00.000Z',
    },
    requestedAt: request3At,
    dueAt: request3Due,
    deadlineTemplate: freezeDeadlineTemplate('us', request3At),
    extendedDays: 0,
    affectedSystemIds: ['sys-crm', 'sys-risk', 'sys-support'],
    tasks: [],
    evidence: [
      {
        id: 'evidence-003-a',
        stepId: 'req-003-execute-sys-crm',
        name: '客户关系管理系统处理回执（RCP-CRM-0928-055）',
        evidenceType: 'system-response',
        digest: 'PD-A014C77E',
        uploadedBy: '客户平台组',
        uploadedAt: req3CrmAt,
        protected: true,
        receiptKey: 'RCP-CRM-0928-055',
        source: 'receipt',
      },
    ],
    systemReceipts: [
      receipt({
        systemId: 'sys-crm',
        receiptKey: 'RCP-CRM-0928-055',
        status: 'accepted',
        summary: '客户系统中的姓名已更正完成。',
        receivedAt: req3CrmAt,
        lastDeliveryAt: req3CrmAt,
        deliveryCount: 1,
        operator: '客户平台组',
        redeliveries: [],
      }),
      receipt({
        systemId: 'sys-risk',
        receiptKey: 'RCP-RISK-0928-008',
        status: 'failed',
        summary: '风控平台拒绝更新风险标签关联姓名，返回值与客户系统不一致。',
        receivedAt: req3RiskAt,
        lastDeliveryAt: req3RiskAt,
        deliveryCount: 1,
        operator: '风险技术组',
        redeliveries: [],
        conflict: '系统回执例外：风控决策平台回执 RCP-RISK-0928-008 返回失败——风控平台拒绝更新风险标签关联姓名，返回值与客户系统不一致。',
      }),
    ],
    conflicts: [
      '系统回执例外：风控决策平台回执 RCP-RISK-0928-008 返回失败——风控平台拒绝更新风险标签关联姓名，返回值与客户系统不一致。',
    ],
    resultSummary: '',
    closureReason: '',
    audit: [
      audit(
        'req-audit-003-risk',
        '系统回执失败进入复核',
        '风险技术组',
        '风控决策平台回执 RCP-RISK-0928-008 返回失败，冲突未复核前不能关闭。',
        req3RiskAt,
      ),
      audit(
        'req-audit-003-crm',
        '接受系统处理回执',
        '客户平台组',
        '接受客户关系管理系统回执 RCP-CRM-0928-055；回执到齐 1/3，等待 2 个系统。',
        req3CrmAt,
      ),
    ],
  }
  request3.tasks = buildWorkflowSteps({
    requestId: 'req-003',
    type: 'rectification',
    systemIds: ['sys-crm', 'sys-risk', 'sys-support'],
    requestedAt: request3At,
    dueAt: request3Due,
    initialStatus: 'processing',
    systems,
  })
  completeSystemTasks(request3, 'sys-crm', req3CrmAt)
  const executeRisk = request3.tasks.find((task) => task.id === 'req-003-execute-sys-risk')
  if (executeRisk) {
    executeRisk.status = 'blocked'
    executeRisk.exceptionReason = '风控平台返回值与客服系统不一致。'
  }

  const req4ReceiptAt = '2026-09-28T09:00:00.000Z'
  const request4: PrivacyRequest = {
    id: 'req-004',
    code: 'DSR-2026-004',
    version: 4,
    requesterName: '陈妙',
    requesterContact: 'ch***@example.com',
    region: 'sg',
    type: 'withdraw-consent',
    status: 'pending-close',
    identity: {
      status: 'verified',
      materialType: 'account-ownership',
      maskedReference: '账号所有权验证通过',
      protectedDigest: 'ACC-880D',
      note: '账号双因素验证通过。',
      reviewedAt: '2026-09-24T07:00:00.000Z',
    },
    requestedAt: request4At,
    dueAt: request4Due,
    deadlineTemplate: freezeDeadlineTemplate('sg', request4At),
    extendedDays: 0,
    affectedSystemIds: ['sys-marketing'],
    tasks: buildWorkflowSteps({
      requestId: 'req-004',
      type: 'withdraw-consent',
      systemIds: ['sys-marketing'],
      requestedAt: request4At,
      dueAt: request4Due,
      initialStatus: 'pending-close',
      systems,
    }),
    evidence: [
      {
        id: 'evidence-004-a',
        stepId: 'req-004-execute-sys-marketing',
        name: '同意状态变更日志（RCP-MKT-0928-031）',
        evidenceType: 'execution-log',
        digest: 'E31A-880D',
        uploadedBy: '增长技术组',
        uploadedAt: req4ReceiptAt,
        protected: true,
        receiptKey: 'RCP-MKT-0928-031',
        source: 'receipt',
      },
    ],
    systemReceipts: [
      receipt({
        systemId: 'sys-marketing',
        receiptKey: 'RCP-MKT-0928-031',
        status: 'accepted',
        summary: '已撤回同意并停止后续自动化触达。',
        receivedAt: req4ReceiptAt,
        lastDeliveryAt: req4ReceiptAt,
        deliveryCount: 1,
        operator: '增长技术组',
        redeliveries: [],
      }),
    ],
    conflicts: [],
    resultSummary: '营销平台已撤回同意并停止后续自动化触达。',
    closureReason: '',
    audit: [
      audit(
        'req-audit-004',
        '待关闭复核',
        '隐私运营',
        '全部系统回执已到齐并合并结果，等待负责人确认关闭。',
        '2026-09-28T09:10:00.000Z',
      ),
    ],
  }

  const req5CrmAt = '2026-09-08T05:00:00.000Z'
  const req5MktAt = '2026-09-08T06:30:00.000Z'
  const request5: PrivacyRequest = {
    id: 'req-005',
    code: 'DSR-2026-005',
    version: 9,
    requesterName: '王宁',
    requesterContact: 'wa***@example.com',
    region: 'eu',
    type: 'deletion',
    status: 'completed',
    identity: {
      status: 'verified',
      materialType: 'masked-id',
      maskedReference: '310***********8832',
      protectedDigest: 'ID-771B',
      note: '身份核验已完成。',
      reviewedAt: '2026-09-05T03:30:00.000Z',
    },
    requestedAt: request5At,
    dueAt: request5Due,
    deadlineTemplate: freezeDeadlineTemplate('eu', request5At),
    extendedDays: 0,
    affectedSystemIds: ['sys-crm', 'sys-marketing'],
    tasks: buildWorkflowSteps({
      requestId: 'req-005',
      type: 'deletion',
      systemIds: ['sys-crm', 'sys-marketing'],
      requestedAt: request5At,
      dueAt: request5Due,
      initialStatus: 'completed',
      systems,
    }),
    evidence: [
      {
        id: 'evidence-005-a',
        stepId: 'req-005-execute-sys-crm',
        name: '删除执行回执（RCP-CRM-0908-077）',
        evidenceType: 'system-response',
        digest: 'E5A0-1201',
        uploadedBy: '客户平台组',
        uploadedAt: req5CrmAt,
        protected: true,
        receiptKey: 'RCP-CRM-0908-077',
        source: 'receipt',
      },
      {
        id: 'evidence-005-b',
        stepId: 'req-005-execute-sys-marketing',
        name: '同意与触达删除回执（RCP-MKT-0908-014）',
        evidenceType: 'system-response',
        digest: 'PD-7B209EE1',
        uploadedBy: '增长技术组',
        uploadedAt: req5MktAt,
        protected: true,
        receiptKey: 'RCP-MKT-0908-014',
        source: 'receipt',
      },
    ],
    systemReceipts: [
      receipt({
        systemId: 'sys-crm',
        receiptKey: 'RCP-CRM-0908-077',
        status: 'accepted',
        summary: '客户主档删除完成，保留最小合规凭证。',
        receivedAt: req5CrmAt,
        lastDeliveryAt: req5CrmAt,
        deliveryCount: 1,
        operator: '客户平台组',
        redeliveries: [],
      }),
      receipt({
        systemId: 'sys-marketing',
        receiptKey: 'RCP-MKT-0908-014',
        status: 'accepted',
        summary: '同意记录与触达标签已删除。',
        receivedAt: req5MktAt,
        lastDeliveryAt: req5MktAt,
        deliveryCount: 1,
        operator: '增长技术组',
        redeliveries: [],
      }),
    ],
    conflicts: [],
    resultSummary: '已完成请求主体在两个系统中的删除，并保留最小合规凭证。',
    closureReason: '期限已到且任务完整，经复核后关闭。',
    audit: [
      audit(
        'req-audit-005',
        '完成请求',
        '隐私负责人',
        '全部系统回执到齐，处理结果合并完成并生成操作审计。',
        '2026-09-10T02:00:00.000Z',
      ),
    ],
  }

  const requests: PrivacyRequest[] = [request1, request2, request3, request4, request5]

  return {
    requests,
    systems,
    comments: [
      {
        id: 'comment-001',
        requestId: 'req-003',
        author: '风控平台管理员',
        content: '风险标签属于反欺诈例外审查范围，不能直接按普通资料更正。',
        createdAt: '2026-09-28T08:35:00.000Z',
      },
      {
        id: 'comment-002',
        requestId: 'req-002',
        author: '隐私运营',
        content: '请先确认该请求与 DSR-2026-005 是否属于重复申请。',
        createdAt: '2026-09-19T02:05:00.000Z',
      },
    ],
    audit: [
      {
        id: 'audit-global-1',
        requestId: 'req-001',
        action: '系统回执重发（按同一笔确认）',
        operator: '系统自动重发',
        detail: '客户关系管理系统回执 RCP-CRM-0928-119 第 2 次送达，按同一笔确认，未重复生成证据。',
        createdAt: req1CrmRedeliveredAt,
      },
      {
        id: 'audit-global-4',
        requestId: 'req-003',
        action: '系统回执失败进入复核',
        operator: '风险技术组',
        detail: '风控决策平台回执 RCP-RISK-0928-008 返回失败，冲突未复核前不能关闭。',
        createdAt: req3RiskAt,
      },
      {
        id: 'audit-global-2',
        requestId: 'req-002',
        action: '身份材料复核',
        operator: '隐私运营',
        detail: '身份材料不足并检测到疑似重复请求。',
        createdAt: '2026-09-19T02:00:00.000Z',
      },
      {
        id: 'audit-global-3',
        requestId: 'req-001',
        action: '登记请求',
        operator: '客服专员',
        detail: '访问请求进入 30 日履约流程，期限模板已冻结。',
        createdAt: request1At,
      },
    ],
    revision: 2,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  }
}

export const requestTypeOptions = [
  { value: 'access', label: '访问' },
  { value: 'rectification', label: '更正' },
  { value: 'deletion', label: '删除' },
  { value: 'withdraw-consent', label: '撤回同意' },
  { value: 'restriction', label: '限制处理' },
] as const
