/**
 * 业务规则冒烟测试（非项目依赖，仅用于本地校验）：
 *   npx tsx scripts/smoke.ts
 * 覆盖：版本守卫、回执幂等、重发不重复生成证据、合并闸口、冲突未复核禁关闭、
 *       冻结模板、旧数据迁移沿用原到期日。
 */
import assert from 'node:assert/strict'
import { createInitialState } from '../src/services/mockData'
import {
  addComment,
  addConflict,
  closeRequest,
  createRequest,
  mergeResults,
  receiptsComplete,
  registerReceipt,
  resolveConflict,
  saveRequest,
  taskAction,
  verifyIdentity,
} from '../src/services/requestService'
import { migrateWorkspace } from '../src/services/migration'
import { regionTemplates } from '../src/services/workflow'
import { assertSnapshotFresh, StaleVersionError } from '../src/lib/concurrency'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const base = createInitialState()
const op = '冒烟测试'

console.log('1) 处理动作绑定当前版本（后保存的整包不得覆盖先完成的结果）')
{
  // 1a) 服务端契约守卫：动作携带的 expectedRevision 必须与所提交快照一致
  const state1 = createRequest(
    base,
    {
      requesterName: '测试用户甲',
      requesterContact: 'test-a@example.com',
      region: 'cn',
      type: 'access',
      affectedSystemIds: ['sys-crm'],
      identityMaterialType: 'masked-id',
      identityReference: '310***********0001',
      note: '',
    },
    '客服专员',
    base.revision,
  )
  assert.equal(state1.revision, base.revision + 1)
  assert.throws(
    () =>
      // 快照已是 R+1，却谎称基于 R：服务端拒绝整包写入
      saveRequest(state1, base.revision, 'req-001', { requesterName: '谎报版本' }, op),
    /版本过期/,
  )
  check('服务端拒绝 expectedRevision 与快照不一致的整包提交', () => {})

  // 1b) 真正的多标签页守卫：两个页面同处版本 R，B 先保存后持久化版本变为 R+1，
  //     A 仍基于 R，提交前对照持久化最新版本即被拒绝。
  assert.doesNotThrow(() => assertSnapshotFresh(base.revision, base.revision))
  assert.throws(
    () => assertSnapshotFresh(base.revision, base.revision + 1),
    StaleVersionError,
  )
  check('页面 B 先行保存后，页面 A 的旧版本动作在提交前被拒绝（不会覆盖 B 的结果）', () => {})

  // 1c) A 刷新到最新版本（R+1）后即可继续
  const refreshed = saveRequest(state1, state1.revision, 'req-001', { requesterName: '张晨（改）' }, op)
  assert.equal(refreshed.revision, state1.revision + 1)
  check('刷新核对到最新版本后动作成功', () => {})
}

console.log('2) 期限模板在登记时冻结，模板改版只影响新登记请求')
{
  let state = createRequest(
    base,
    {
      requesterName: '冻结测试',
      requesterContact: 'freeze-smoke2@example.com',
      region: 'cn',
      type: 'access',
      affectedSystemIds: ['sys-crm'],
      identityMaterialType: 'masked-id',
      identityReference: '310***********0002',
      note: '',
    },
    op,
    base.revision,
  )
  const created = state.requests[0]
  assert.equal(created.deadlineTemplate?.version, regionTemplates.cn.version)
  const days = Math.round(
    (new Date(created.dueAt).getTime() - new Date(created.requestedAt).getTime()) / 86_400_000,
  )
  assert.equal(days, regionTemplates.cn.responseDays)
  check(`登记请求按 ${regionTemplates.cn.version} 冻结 ${days} 日期限`, () => {})
  // 模拟之后模板天数变化
  const original = regionTemplates.cn.responseDays
  ;(regionTemplates.cn as { responseDays: number }).responseDays = 45
  try {
    const state2 = createRequest(
      state,
      {
        requesterName: '新模板请求',
        requesterContact: 'new-tmpl-smoke2@example.com',
        region: 'cn',
        type: 'access',
        affectedSystemIds: ['sys-crm'],
        identityMaterialType: 'masked-id',
        identityReference: '310***********0003',
        note: '',
      },
      op,
      state.revision,
    )
    const older = state2.requests.find((r) => r.id === created.id)!
    const newer = state2.requests[0]
    const oldDays = Math.round(
      (new Date(older.dueAt).getTime() - new Date(older.requestedAt).getTime()) / 86_400_000,
    )
    const newDays = Math.round(
      (new Date(newer.dueAt).getTime() - new Date(newer.requestedAt).getTime()) / 86_400_000,
    )
    assert.equal(oldDays, 30)
    assert.equal(newDays, 45)
    check('旧请求仍是 30 日，新登记请求才用 45 日模板', () => {})
  } finally {
    ;(regionTemplates.cn as { responseDays: number }).responseDays = original
  }
}

console.log('3) 跨系统回执：首次接受生成证据，超时重发按同一笔不重复生成证据')
{
  // 用全新单系统请求快速走通：登记 -> 核验通过 -> 回执
  let state = createRequest(
    base,
    {
      requesterName: '回执测试',
      requesterContact: 'receipt-smoke3@example.com',
      region: 'eu',
      type: 'deletion',
      affectedSystemIds: ['sys-crm', 'sys-marketing'],
      identityMaterialType: 'masked-id',
      identityReference: '310***********0004',
      note: '',
    },
    op,
    base.revision,
  )
  const reqId = state.requests[0].id
  state = verifyIdentity(state, state.revision, reqId, 'verified', '核验通过', op)
  const before = state.requests[0].evidence.length
  const first = registerReceipt(
    state,
    state.revision,
    reqId,
    {
      systemId: 'sys-crm',
      idempotencyKey: 'RC-SMOKE-1',
      outcome: 'success',
      payloadSummary: '删除成功',
      note: '',
      isResend: false,
    },
    op,
  )
  state = first.state
  assert.equal(first.duplicate, false)
  assert.equal(state.requests[0].evidence.length, before + 1)
  check('首次回执被接受并生成一份证据', () => {})

  // 超时重发：同幂等键
  const resent = registerReceipt(
    state,
    state.revision,
    reqId,
    {
      systemId: 'sys-crm',
      idempotencyKey: 'RC-SMOKE-1',
      outcome: 'success',
      payloadSummary: '删除成功（重发）',
      note: '接口超时重发',
      isResend: true,
    },
    op,
  )
  state = resent.state
  assert.equal(resent.duplicate, true)
  assert.equal(state.requests[0].evidence.length, before + 1, '重发不得再生成证据')
  const receipt = state.requests[0].receipts!.find((r) => r.idempotencyKey === 'RC-SMOKE-1')!
  assert.equal(receipt.attempts.length, 2)
  assert.equal(receipt.attempts[1].kind, 'resent')
  check('同编号重发按同一笔认：仅追加重发尝试，证据仍是一份', () => {})

  // 不同幂等键但同系统已有接受回执，也按同一系统的同一笔算
  const resent2 = registerReceipt(
    state,
    state.revision,
    reqId,
    {
      systemId: 'sys-crm',
      idempotencyKey: 'RC-SMOKE-1-DUP-NEW-KEY',
      outcome: 'success',
      payloadSummary: '再次送达',
      note: '',
      isResend: true,
    },
    op,
  )
  assert.equal(resent2.duplicate, true)
  assert.equal(resent2.state.requests[0].evidence.length, before + 1)
  check('换编号但同系统重发仍认作同一笔，不生成证据', () => {})
}

console.log('4) 全部系统回执到齐才能合并；未到齐合并被拒绝')
{
  let state = createRequest(
    base,
    {
      requesterName: '合并测试',
      requesterContact: 'merge-smoke4@example.com',
      region: 'sg',
      type: 'withdraw-consent',
      affectedSystemIds: ['sys-crm', 'sys-marketing'],
      identityMaterialType: 'account-ownership',
      identityReference: 'account-verify-ref-0005',
      note: '',
    },
    op,
    base.revision,
  )
  const reqId = state.requests[0].id
  state = verifyIdentity(state, state.revision, reqId, 'verified', '核验通过', op)
  assert.equal(receiptsComplete(state.requests[0]), false)
  assert.throws(() => mergeResults(state, state.revision, reqId, '提前合并', op), /回执未到齐/)
  check('回执未到齐时合并被拒绝', () => {})

  state = registerReceipt(
    state,
    state.revision,
    reqId,
    {
      systemId: 'sys-crm',
      idempotencyKey: 'RC-M-CRM',
      outcome: 'success',
      payloadSummary: 'ok',
      note: '',
      isResend: false,
    },
    op,
  ).state
  assert.equal(receiptsComplete(state.requests.find((r) => r.id === reqId)!), false)
  assert.throws(() => mergeResults(state, state.revision, reqId, '只到一个系统', op), /回执未到齐/)
  check('仅 1/2 系统回执时仍不能合并', () => {})

  state = registerReceipt(
    state,
    state.revision,
    reqId,
    {
      systemId: 'sys-marketing',
      idempotencyKey: 'RC-M-MKT',
      outcome: 'success',
      payloadSummary: 'ok',
      note: '',
      isResend: false,
    },
    op,
  ).state
  assert.equal(receiptsComplete(state.requests.find((r) => r.id === reqId)!), true)
  state = mergeResults(state, state.revision, reqId, '两系统结果一致，合并完成', op)
  const req = state.requests.find((r) => r.id === reqId)!
  assert.equal(req.status, 'pending-close')
  assert.ok(req.merge)
  assert.deepEqual(
    req.merge!.receiptIds.sort(),
    req.receipts!.map((r) => r.id).sort(),
  )
  check('两系统回执到齐后合并成功并进入待关闭', () => {})
}

console.log('5) 冲突没复核前不能关闭；逐项复核 + 合并后才能关闭')
{
  let state = createRequest(
    base,
    {
      requesterName: '冲突测试',
      requesterContact: 'conflict-smoke5@example.com',
      region: 'cn',
      type: 'access',
      affectedSystemIds: ['sys-crm'],
      identityMaterialType: 'masked-id',
      identityReference: '310***********0006',
      note: '',
    },
    op,
    base.revision,
  )
  const reqId = state.requests[0].id
  state = verifyIdentity(state, state.revision, reqId, 'verified', '核验通过', op)
  // 回执声明冲突
  state = registerReceipt(
    state,
    state.revision,
    reqId,
    {
      systemId: 'sys-crm',
      idempotencyKey: 'RC-CF-1',
      outcome: 'conflict',
      payloadSummary: '与预期数据范围不一致',
      note: '',
      isResend: false,
    },
    op,
  ).state
  const req0 = state.requests.find((r) => r.id === reqId)!
  assert.equal(req0.conflicts.length, 1)
  assert.equal(req0.conflicts[0].resolved, false)
  // 该系统只有冲突回执、没有已接受回执，合并先被闸口拦截
  assert.throws(
    () => mergeResults(state, state.revision, reqId, '带冲突合并', op),
    /回执未到齐|未复核冲突/,
  )
  check('存在冲突回执时不能合并（回执/冲突闸口生效）', () => {})

  // 复核冲突
  const conflictId = req0.conflicts[0].id
  state = resolveConflict(state, state.revision, reqId, conflictId, '经核对系数据范围差异，接受系统结果。', op)
  assert.equal(state.requests.find((r) => r.id === reqId)!.conflicts[0].resolved, true)
  assert.ok(state.requests.find((r) => r.id === reqId)!.conflicts[0].resolvedBy)
  check('冲突逐项记录复核人、时间与结论', () => {})

  // 冲突回执不算 accepted，需要补一份成功回执（之前是 conflict 状态回执，不占 accepted，成功回执正常接受）
  state = registerReceipt(
    state,
    state.revision,
    reqId,
    {
      systemId: 'sys-crm',
      idempotencyKey: 'RC-CF-1-OK',
      outcome: 'success',
      payloadSummary: '复核后重新执行成功',
      note: '',
      isResend: false,
    },
    op,
  ).state
  // 回执已到齐，但再挂一个未复核冲突：合并必须被冲突闸口拦住
  state = addConflict(state, state.revision, reqId, '合并前发现结果描述与实际范围不符。', op)
  assert.throws(
    () => mergeResults(state, state.revision, reqId, '带未复核冲突合并', op),
    /未复核冲突/,
  )
  check('回执到齐但存在未复核冲突时，合并被拒绝', () => {})
  const mergeConflict = state.requests.find((r) => r.id === reqId)!.conflicts.at(-1)!
  state = resolveConflict(state, state.revision, reqId, mergeConflict.id, '描述已更正，范围核对一致。', op)
  state = mergeResults(state, state.revision, reqId, '冲突消解，结果合并。', op)
  // 合并后复核任务进入活动态，完成它（关闭前所有非关闭任务必须完成）
  state = taskAction(
    state,
    state.revision,
    reqId,
    `${reqId}-review`,
    'complete',
    '复核完整性确认。',
    op,
  )
  // 再人为制造一个未复核冲突，验证关闭闸口
  state = addConflict(state, state.revision, reqId, '关闭前新增例外：导出包字段待确认。', op)
  assert.throws(
    () => closeRequest(state, state.revision, reqId, '总结', '', op),
    /冲突未复核/,
  )
  check('存在未复核冲突时关闭被拒绝', () => {})

  const newConflict = state.requests.find((r) => r.id === reqId)!.conflicts.at(-1)!
  state = resolveConflict(state, state.revision, reqId, newConflict.id, '字段已确认无误。', op)
  state = closeRequest(
    state,
    state.revision,
    reqId,
    '全部完成。',
    '全部系统回执已到齐、冲突已复核，经负责人确认提前关闭。',
    op,
  )
  assert.equal(state.requests.find((r) => r.id === reqId)!.status, 'completed')
  check('冲突全部复核后关闭成功', () => {})
}

console.log('6) 旧浏览器数据（无版本号）迁移：补齐核验/模板/回执，沿用原到期日')
{
  // 构造一个 v1 形态的旧工作区：字符串冲突、无 deadlineTemplate、无 receipts、
  // 身份已核验但无 reviewedAt、执行任务已完成。
  const legacy = structuredClone(base)
  const legacyState = {
    requests: legacy.requests.map((request) => {
      const { deadlineTemplate, schemaVersion, receipts, merge, ...rest } = request
      return {
        ...rest,
        identity: {
          status: rest.identity.status,
          materialType: rest.identity.materialType,
          maskedReference: rest.identity.maskedReference,
          protectedDigest: rest.identity.protectedDigest,
          note: rest.identity.note,
        },
        conflicts: rest.conflicts.map((conflict) => conflict.description),
      }
    }),
    systems: legacy.systems,
    comments: legacy.comments,
    audit: legacy.audit,
    revision: 7,
  }
  const beforeDue = new Map(
    legacyState.requests.map((request) => [request.id, request.dueAt]),
  )
  const migrated = migrateWorkspace(legacyState)
  assert.ok(migrated, '迁移应成功')
  assert.equal(migrated!.schemaVersion, 2)
  assert.equal(migrated!.revision, 7, '迁移不得推进版本号')
  for (const request of migrated!.requests) {
    assert.equal(request.dueAt, beforeDue.get(request.id), `${request.code} 到期日必须保持不变`)
    assert.ok(request.deadlineTemplate, `${request.code} 应补齐冻结模板`)
    assert.equal(request.schemaVersion, 2)
    if (request.identity.status !== 'pending') {
      assert.ok(request.identity.reviewedAt, `${request.code} 应补齐核验时间`)
      assert.ok(request.identity.reviewedBy, `${request.code} 应补齐核验人`)
    }
  }
  check('所有旧请求到期日不变，且补齐冻结模板与核验记录', () => {})

  // req-005 已完成、两个执行任务均完成，应回填 2 份回执与合并记录
  const req005 = migrated!.requests.find((request) => request.code === 'DSR-2026-005')!
  assert.equal(req005.receipts!.length, 2)
  assert.ok(req005.receipts!.every((receipt) => receipt.backfilled))
  assert.ok(req005.merge)
  check('已完成请求回填系统回执（标记迁移回填，未重新生成证据）与合并记录', () => {})

  // 旧字符串冲突迁移为结构化、未复核
  const req002 = migrated!.requests.find((request) => request.code === 'DSR-2026-002')!
  assert.equal(req002.conflicts.length, 2)
  assert.ok(req002.conflicts.every((conflict) => conflict.resolved === false))
  assert.ok(req002.audit.some((entry) => entry.action === '旧版工作区数据迁移'))
  check('旧字符串冲突升级为待复核结构化冲突，并追加迁移审计', () => {})

  // 迁移后的数据能通过正常操作继续流转（版本守卫生效）
  assert.throws(
    () => addComment(migrated!, 999_999, req005.id, '旧版本号应被拒绝', op),
    /版本过期/,
  )
  const next = addComment(migrated!, migrated!.revision, req005.id, '迁移后可继续操作', op)
  assert.equal(next.revision, migrated!.revision + 1)
  check('迁移后版本守卫生效，基于新 revision 可继续操作', () => {})
}

console.log(`\n全部 ${passed} 项冒烟检查通过 ✅`)
