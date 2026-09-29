'use client'

import { useMemo, useState } from 'react'
import NextLink from 'next/link'
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Flex,
  FormControl,
  FormLabel,
  HStack,
  Heading,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Progress,
  Select,
  SimpleGrid,
  Table,
  TableContainer,
  Tbody,
  Td,
  Text,
  Textarea,
  Th,
  Thead,
  Tr,
  VStack,
  useDisclosure,
  useToast,
} from '@chakra-ui/react'
import {
  ArrowLeft,
  FileCheck2,
  GitMerge,
  Link2Off,
  MailWarning,
  ShieldAlert,
  Snowflake,
} from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { StatusBadge, TypeBadge } from '@/components/StatusBadge'
import {
  isVersionConflictError,
  useAddCommentMutation,
  useAddConflictMutation,
  useAddEvidenceMutation,
  useAssignTaskMutation,
  useCloseRequestMutation,
  useExtendRequestMutation,
  useMergeResultsMutation,
  useRegisterReceiptMutation,
  useResolveConflictMutation,
  useSaveRequestMutation,
  useTaskActionMutation,
  useVerifyIdentityMutation,
  useWorkspaceQuery,
} from '@/lib/hooks'
import {
  receiptAttemptLabels,
  receiptStatusLabels,
  regionLabels,
  requestTypeLabels,
  type ConflictRecord,
  type Region,
  type RequestType,
  type SystemReceipt,
  type WorkflowStep,
} from '@/lib/schemas'
import { deadlineState, regionTemplates, templateName } from '@/services/workflow'
import { pendingSystems, receiptsComplete } from '@/services/requestService'

type DialogType =
  | 'edit'
  | 'identity'
  | 'assign'
  | 'evidence'
  | 'receipt'
  | 'merge'
  | 'block'
  | 'conflict'
  | 'resolve'
  | 'extend'
  | 'close'
  | null

const attemptColor = {
  accepted: 'green',
  resent: 'orange',
  conflict: 'red',
} as const

export function RequestDetailPage({ requestId }: { requestId: string }) {
  const { data, isLoading } = useWorkspaceQuery()
  const toast = useToast()
  const { isOpen, onOpen, onClose } = useDisclosure()
  const request = data?.requests.find((item) => item.id === requestId)
  const [dialog, setDialog] = useState<DialogType>(null)
  const [selectedTask, setSelectedTask] = useState<WorkflowStep>()
  const [resolveConflictId, setResolveConflictId] = useState('')
  const [content, setContent] = useState('')
  const [assignee, setAssignee] = useState('')
  const [identityStatus, setIdentityStatus] = useState<'verified' | 'insufficient'>('verified')
  const [evidenceType, setEvidenceType] = useState<
    'execution-log' | 'screenshot' | 'signed-record' | 'system-response'
  >('execution-log')
  const [extendDays, setExtendDays] = useState(15)
  const [editForm, setEditForm] = useState({
    requesterName: '',
    requesterContact: '',
  })
  const [receiptForm, setReceiptForm] = useState({
    systemId: '',
    idempotencyKey: '',
    outcome: 'success' as 'success' | 'conflict',
    payloadSummary: '',
    isResend: false,
  })

  const saveRequest = useSaveRequestMutation()
  const verifyIdentity = useVerifyIdentityMutation()
  const assignTask = useAssignTaskMutation()
  const taskAction = useTaskActionMutation()
  const addEvidence = useAddEvidenceMutation()
  const registerReceipt = useRegisterReceiptMutation()
  const mergeResults = useMergeResultsMutation()
  const addConflict = useAddConflictMutation()
  const resolveConflict = useResolveConflictMutation()
  const extendRequest = useExtendRequestMutation()
  const closeRequest = useCloseRequestMutation()
  const addComment = useAddCommentMutation()

  const comments = useMemo(
    () => data?.comments.filter((comment) => comment.requestId === requestId) ?? [],
    [data, requestId],
  )

  if (isLoading || !data) return <Box className="panel">正在加载请求详情...</Box>
  if (!request) return <Box className="panel">请求不存在或已从工作区移除。</Box>

  const deadline = deadlineState(request.dueAt)
  const completedTasks = request.tasks.filter((task) => task.status === 'completed').length
  const currentTask = request.tasks.find((task) => task.status === 'active')
  const systems = data.systems.filter((system) => request.affectedSystemIds.includes(system.id))
  const systemName = (systemId: string) =>
    data.systems.find((system) => system.id === systemId)?.name ?? systemId
  const receipts = request.receipts ?? []
  const receiptBySystem = new Map<string, SystemReceipt>(
    receipts.map((receipt) => [receipt.systemId, receipt]),
  )
  const blockingSystemIds = pendingSystems(request)
  const allReceiptsIn = receiptsComplete(request)
  const unresolvedConflicts = request.conflicts.filter((item) => !item.resolved)
  const merged = Boolean(request.merge)
  const templateChanged =
    request.deadlineTemplate &&
    regionTemplates[request.region].version !== request.deadlineTemplate.version

  function openDialog(type: DialogType, task?: WorkflowStep, conflict?: ConflictRecord) {
    setSelectedTask(task)
    setResolveConflictId(conflict?.id ?? '')
    setDialog(type)
    setContent('')
    if (type === 'assign') setAssignee(task?.assignee ?? '')
    if (type === 'edit') {
      setEditForm({
        requesterName: request!.requesterName,
        requesterContact: request!.requesterContact,
      })
    }
    if (type === 'receipt') {
      const systemId =
        task?.systemId ?? blockingSystemIds[0] ?? request!.affectedSystemIds[0] ?? ''
      setReceiptForm({
        systemId,
        idempotencyKey: `RC-${request!.code.slice(-3)}-${systemId.replace('sys-', '').toUpperCase()}-${Date.now() % 1000}`,
        outcome: 'success',
        payloadSummary: '',
        isResend: false,
      })
    }
    onOpen()
  }

  /** 版本过期时给出可操作的刷新提示，避免在旧页面继续覆盖他人结果。 */
  function failToast(error: unknown, fallback: string) {
    if (isVersionConflictError(error)) {
      toast({
        title: '操作基于过期版本，已被拒绝',
        description: '另一个页面或系统已先保存结果，请刷新核对最新任务、回执与审计后重试。',
        status: 'error',
        duration: 9000,
      })
    } else {
      toast({
        title: fallback,
        description: error instanceof Error ? error.message : '请检查输入和流程状态',
        status: 'error',
      })
    }
  }

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action()
      toast({ title: success, status: 'success' })
      onClose()
    } catch (error) {
      failToast(error, '操作未完成')
    }
  }

  async function submitDialog() {
    if (!dialog) return
    if (dialog === 'edit') {
      await run(
        () =>
          saveRequest.mutateAsync({
            requestId,
            patch: editForm,
            operator: '隐私运营',
          }),
        '请求联系信息已保存（地区、类型与期限模板已冻结）',
      )
    } else if (dialog === 'identity') {
      await run(
        () =>
          verifyIdentity.mutateAsync({
            requestId,
            status: identityStatus,
            note: content,
            operator: '隐私运营',
          }),
        identityStatus === 'verified' ? '身份核验已通过' : '身份材料已退回复核',
      )
    } else if (dialog === 'assign' && selectedTask) {
      await run(
        () =>
          assignTask.mutateAsync({
            requestId,
            taskId: selectedTask.id,
            assignee,
            operator: '隐私运营',
          }),
        '任务已分派',
      )
    } else if (dialog === 'evidence' && selectedTask) {
      await run(
        () =>
          addEvidence.mutateAsync({
            requestId,
            taskId: selectedTask.id,
            name: content,
            evidenceType,
            operator: '数据管理员',
          }),
        '执行证据已受保护登记',
      )
    } else if (dialog === 'receipt') {
      try {
        const result = await registerReceipt.mutateAsync({
          requestId,
          systemId: receiptForm.systemId,
          idempotencyKey: receiptForm.idempotencyKey.trim(),
          outcome: receiptForm.outcome,
          payloadSummary: receiptForm.payloadSummary.trim(),
          note: content.trim(),
          isResend: receiptForm.isResend,
          operator: systemName(receiptForm.systemId) ? `${systemName(receiptForm.systemId)}回执` : '系统接口',
        })
        toast(
          result.duplicate
            ? {
                title: '该回执此前已接受，本次按同一笔重发记录',
                description: '未重复生成证据、未改变首次完成时间，仅追加重发尝试。',
                status: 'warning',
                duration: 8000,
              }
            : { title: '系统回执已接受，回执证据已生成', status: 'success' },
        )
        onClose()
      } catch (error) {
        failToast(error, '回执登记失败')
      }
    } else if (dialog === 'merge') {
      await run(
        () =>
          mergeResults.mutateAsync({
            requestId,
            note: content,
            operator: '隐私运营',
          }),
        '跨系统回执已全部到齐，结果合并完成',
      )
    } else if (dialog === 'block' && selectedTask) {
      await run(
        () =>
          taskAction.mutateAsync({
            requestId,
            taskId: selectedTask.id,
            action: 'block',
            note: content,
            operator: '数据管理员',
          }),
        '任务已阻断并进入复核',
      )
    } else if (dialog === 'conflict') {
      await run(
        () =>
          addConflict.mutateAsync({
            requestId,
            conflict: content,
            operator: '数据管理员',
          }),
        '冲突或例外已进入复核队列',
      )
    } else if (dialog === 'resolve') {
      await run(
        () =>
          resolveConflict.mutateAsync({
            requestId,
            conflictId: resolveConflictId,
            resolution: content,
            operator: '隐私负责人',
          }),
        '复核结论已记录',
      )
    } else if (dialog === 'extend') {
      await run(
        () =>
          extendRequest.mutateAsync({
            requestId,
            days: extendDays,
            reason: content,
            operator: '隐私负责人',
          }),
        `已延期 ${extendDays} 天`,
      )
    } else if (dialog === 'close') {
      await run(
        () =>
          closeRequest.mutateAsync({
            requestId,
            resultSummary: content,
            closureReason: deadline.overdue ? '' : '全部系统回执已到齐并完成合并，经复核后提前关闭。',
            operator: '隐私负责人',
          }),
        '请求已完成并关闭',
      )
    }
  }

  async function taskMutation(task: WorkflowStep, action: 'start' | 'complete') {
    try {
      await taskAction.mutateAsync({
        requestId,
        taskId: task.id,
        action,
        note: action === 'start' ? '开始执行任务。' : '任务结果已提交。',
        operator: task.assignee || '数据管理员',
      })
      toast({ title: action === 'start' ? '任务已开始' : '任务已完成', status: 'success' })
    } catch (error) {
      failToast(error, '任务状态未更新')
    }
  }

  const dialogTitle: Record<Exclude<DialogType, null>, string> = {
    edit: '编辑请求联系信息',
    identity: '身份核验结论',
    assign: '分派履约任务',
    evidence: '登记执行证据',
    receipt: '登记跨系统处理回执',
    merge: '合并跨系统处理结果',
    block: '阻断任务并说明原因',
    conflict: '新增冲突或例外',
    resolve: '记录冲突复核结论',
    extend: '延期处理请求',
    close: '关闭请求并合并结果',
  }

  const canClose =
    request.identity.status === 'verified' &&
    allReceiptsIn &&
    merged &&
    unresolvedConflicts.length === 0

  return (
    <Box>
      <PageHeader
        title={`${request.code} · ${request.requesterName}`}
        description="处理动作绑定当前工作区版本；系统回执按幂等键认作同一笔，全部到齐后才合并，冲突逐项复核后才能关闭。"
        actions={
          <>
            <NextLink href="/requests">
              <Button variant="outline" leftIcon={<ArrowLeft size={16} />}>
                返回列表
              </Button>
            </NextLink>
            <Button variant="outline" onClick={() => openDialog('edit')}>
              编辑信息
            </Button>
            <Button
              colorScheme="brand"
              isDisabled={!canClose}
              onClick={() => openDialog('close')}
              title={canClose ? '' : '回执未到齐、未合并或冲突未复核时不能关闭'}
            >
              完成并关闭
            </Button>
          </>
        }
      />

      <SimpleGrid columns={4} spacing="4" mb="5">
        <Box className="metric">
          <Text color="gray.600" fontSize="sm">
            当前状态
          </Text>
          <Box mt="2">
            <StatusBadge status={request.status} />
          </Box>
          <Text mt="2" color="gray.500" fontSize="xs">
            工作区版本 rev-{data.revision} ·{' '}
            {request.extendedDays ? `延期 ${request.extendedDays} 天` : '原期限'}
          </Text>
        </Box>
        <Box className="metric warning">
          <Text color="gray.600" fontSize="sm">
            剩余期限
          </Text>
          <Heading mt="2" color={deadline.color} size="md">
            {deadline.label}
          </Heading>
          <Text mt="1" color="gray.500" fontSize="xs">
            {new Date(request.dueAt).toLocaleString('zh-CN')}
          </Text>
        </Box>
        <Box className="metric info">
          <Text color="gray.600" fontSize="sm">
            系统回执
          </Text>
          <Heading mt="2" size="md">
            {receipts.filter((receipt) => receipt.status === 'accepted').length} /{' '}
            {request.affectedSystemIds.length}
          </Heading>
          <Progress
            mt="2"
            size="sm"
            value={(receipts.filter((receipt) => receipt.status === 'accepted').length /
              Math.max(1, request.affectedSystemIds.length)) *
              100}
            colorScheme="brand"
          />
        </Box>
        <Box className={`metric ${unresolvedConflicts.length ? 'danger' : ''}`}>
          <Text color="gray.600" fontSize="sm">
            待复核冲突
          </Text>
          <Heading mt="2" size="md">
            {unresolvedConflicts.length}
          </Heading>
          <Text mt="1" color="gray.500" fontSize="xs">
            {merged ? '已合并跨系统结果' : '未复核或未合并时禁止关闭'}
          </Text>
        </Box>
      </SimpleGrid>

      {blockingSystemIds.length ? (
        <Alert status="warning" mb="4" borderRadius="5px">
          <HStack align="flex-start">
            <MailWarning size={18} />
            <Box>
              <Text fontWeight="600">
                当前请求卡在：{blockingSystemIds.map((id) => systemName(id)).join('、')}
              </Text>
              <Text mt="1" fontSize="sm">
                上述系统尚未返回已接受回执（或回执声明冲突），全部到齐前不能合并与关闭。
              </Text>
            </Box>
          </HStack>
        </Alert>
      ) : unresolvedConflicts.length ? (
        <Alert status="error" mb="4" borderRadius="5px">
          全部系统回执已到齐，但仍有 {unresolvedConflicts.length} 项冲突未复核，复核前不能合并、关闭。
        </Alert>
      ) : !merged ? (
        <Alert status="info" mb="4" borderRadius="5px">
          全部系统回执已到齐且无未决冲突，可以执行跨系统结果合并。
        </Alert>
      ) : null}

      <div className="two-column">
        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">请求与身份核验</Heading>
            <HStack>
              <TypeBadge type={request.type} />
              <Button size="xs" onClick={() => openDialog('identity')}>
                身份结论
              </Button>
            </HStack>
          </Flex>
          <SimpleGrid columns={2} spacing="4">
            <Box>
              <Text color="gray.500" fontSize="xs">
                请求人
              </Text>
              <Text mt="1" fontWeight="600">
                {request.requesterName}
              </Text>
            </Box>
            <Box>
              <Text color="gray.500" fontSize="xs">
                联系方式
              </Text>
              <Text mt="1">{request.requesterContact}</Text>
            </Box>
            <Box>
              <Text color="gray.500" fontSize="xs">
                地区与类型
              </Text>
              <Text mt="1">
                {regionLabels[request.region]} · {requestTypeLabels[request.type]}
              </Text>
            </Box>
            <Box>
              <Text color="gray.500" fontSize="xs">
                身份核验状态
              </Text>
              <Box mt="1">
                <Badge
                  colorScheme={
                    request.identity.status === 'verified'
                      ? 'green'
                      : request.identity.status === 'insufficient'
                        ? 'red'
                        : 'orange'
                  }
                >
                  {request.identity.status === 'verified'
                    ? '已通过'
                    : request.identity.status === 'insufficient'
                      ? '材料不足'
                      : '待核验'}
                </Badge>
              </Box>
            </Box>
          </SimpleGrid>
          <Divider my="4" />
          <HStack align="flex-start" spacing="3">
            <FileCheck2 size={19} color="#237b78" />
            <Box>
              <Text fontWeight="600">受保护身份摘要</Text>
              <Text mt="1" color="gray.600" fontSize="sm">
                {request.identity.maskedReference || '未提供引用'} ·{' '}
                <span className="mono">{request.identity.protectedDigest}</span>
              </Text>
              <Text mt="2" color="gray.600" fontSize="sm">
                {request.identity.note || '暂无核验说明'}
              </Text>
              {request.identity.reviewedAt ? (
                <Text mt="1" color="gray.500" fontSize="xs">
                  核验记录：{request.identity.reviewedBy ?? '核验人'} ·{' '}
                  {new Date(request.identity.reviewedAt).toLocaleString('zh-CN')}
                </Text>
              ) : null}
            </Box>
          </HStack>
        </Box>

        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">涉及系统与冻结期限模板</Heading>
            <Badge colorScheme="blue">{systems.length} 个系统</Badge>
          </Flex>
          <Box p="3" bg="gray.50" borderRadius="5px" mb="3">
            <HStack mb="1">
              <Snowflake size={16} color="#3e73a4" />
              <Text fontWeight="600" fontSize="sm">
                {templateName(request.region, request.type, request.deadlineTemplate)}
              </Text>
            </HStack>
            <Text color="gray.600" fontSize="xs">
              登记时冻结，{request.extendedDays ? `已延期 ${request.extendedDays} 天，` : ''}
              到期日 {new Date(request.dueAt).toLocaleDateString('zh-CN')} 不随后续模板改版变化。
            </Text>
            {templateChanged ? (
              <Badge mt="2" colorScheme="purple">
                地区模板已更新为 {regionTemplates[request.region].version}，仅影响之后登记的请求
              </Badge>
            ) : null}
          </Box>
          <VStack align="stretch" spacing="2">
            {systems.map((system) => {
              const receipt = receiptBySystem.get(system.id)
              const blocked = blockingSystemIds.includes(system.id)
              return (
                <Flex
                  key={system.id}
                  p="3"
                  bg={blocked ? 'orange.50' : 'gray.50'}
                  borderRadius="5px"
                  justify="space-between"
                  align="center"
                >
                  <Box>
                    <Text fontWeight="600" fontSize="sm">
                      {system.name}
                    </Text>
                    <Text color="gray.600" fontSize="xs">
                      {system.owner} · {system.transferMethod}
                    </Text>
                  </Box>
                  <HStack>
                    {receipt ? (
                      <Badge colorScheme={receipt.status === 'accepted' ? 'green' : 'red'}>
                        {receiptStatusLabels[receipt.status]}
                        {receipt.backfilled ? '（迁移回填）' : ''}
                      </Badge>
                    ) : (
                      <Badge colorScheme="orange">等待回执 · 卡住</Badge>
                    )}
                    {blocked && request.identity.status === 'verified' ? (
                      <Button size="xs" colorScheme="orange" variant="outline" onClick={() => openDialog('receipt', undefined)}>
                        登记回执
                      </Button>
                    ) : null}
                  </HStack>
                </Flex>
              )
            })}
          </VStack>
        </Box>
      </div>

      <Box className="panel" mb="4">
        <Flex className="panel-title">
          <Heading size="sm">跨系统回执与结果合并</Heading>
          <HStack>
            <Badge colorScheme={allReceiptsIn ? 'green' : 'orange'}>
              {allReceiptsIn ? '回执已到齐' : `还差 ${blockingSystemIds.length} 个系统`}
            </Badge>
            <Button
              size="xs"
              colorScheme="brand"
              leftIcon={<GitMerge size={14} />}
              isDisabled={!allReceiptsIn || unresolvedConflicts.length > 0 || merged}
              onClick={() => openDialog('merge')}
            >
              {merged ? '已合并' : '合并结果'}
            </Button>
            <Button size="xs" variant="outline" onClick={() => openDialog('receipt')}>
              登记回执
            </Button>
          </HStack>
        </Flex>

        {!allReceiptsIn ? (
          <Alert status="warning" mb="3" borderRadius="5px">
            跨系统回执全部到齐后才能合并；登记动作绑定当前版本，其他系统刚保存的结果不会被本页覆盖。
          </Alert>
        ) : null}

        <TableContainer>
          <Table size="sm">
            <Thead>
              <Tr>
                <Th>系统</Th>
                <Th>回执状态</Th>
                <Th>幂等键 / 摘要</Th>
                <Th>送达记录（首次接受 / 重发）</Th>
                <Th>首次接受时间</Th>
              </Tr>
            </Thead>
            <Tbody>
              {systems.map((system) => {
                const receipt = receiptBySystem.get(system.id)
                if (!receipt) {
                  return (
                    <Tr key={system.id}>
                      <Td fontWeight="600">{system.name}</Td>
                      <Td>
                        <Badge colorScheme="orange">等待回执</Badge>
                      </Td>
                      <Td colSpan={3}>
                        <Text color="gray.500" fontSize="sm">
                          该系统尚未返回回执，请求当前卡在这里。
                        </Text>
                      </Td>
                    </Tr>
                  )
                }
                return (
                  <Tr key={system.id}>
                    <Td fontWeight="600">{system.name}</Td>
                    <Td>
                      <Badge colorScheme={receipt.status === 'accepted' ? 'green' : 'red'}>
                        {receiptStatusLabels[receipt.status]}
                      </Badge>
                    </Td>
                    <Td>
                      <Text className="mono" fontSize="xs">
                        {receipt.idempotencyKey}
                      </Text>
                      <Text color="gray.600" fontSize="xs">
                        {receipt.payloadSummary}
                      </Text>
                    </Td>
                    <Td>
                      <VStack align="flex-start" spacing="1">
                        {receipt.attempts.map((attempt) => (
                          <HStack key={attempt.id} spacing="2">
                            <Badge colorScheme={attemptColor[attempt.kind]}>
                              {receiptAttemptLabels[attempt.kind]}
                            </Badge>
                            <Text color="gray.500" fontSize="xs">
                              {new Date(attempt.receivedAt).toLocaleString('zh-CN')}
                              {attempt.note ? ` · ${attempt.note}` : ''}
                            </Text>
                          </HStack>
                        ))}
                      </VStack>
                    </Td>
                    <Td whiteSpace="nowrap" fontSize="sm">
                      {new Date(receipt.receivedAt).toLocaleString('zh-CN')}
                    </Td>
                  </Tr>
                )
              })}
            </Tbody>
          </Table>
        </TableContainer>

        {request.merge ? (
          <Alert status="success" mt="3" borderRadius="5px">
            <Box>
              <Text fontWeight="600">
                已于 {new Date(request.merge.mergedAt).toLocaleString('zh-CN')} 由{' '}
                {request.merge.mergedBy} 合并 {request.merge.receiptIds.length} 份系统回执
              </Text>
              <Text mt="1" fontSize="sm">
                {request.merge.note}
              </Text>
            </Box>
          </Alert>
        ) : (
          <Text mt="3" color="gray.500" fontSize="sm">
            合并仅在全部系统回执到齐且冲突清零后开放；合并后系统新回执仍按同一幂等键识别为重发。
          </Text>
        )}
      </Box>

      <div className="three-column">
        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">当前动作</Heading>
            <Badge colorScheme={request.identity.status === 'verified' ? 'green' : 'red'}>
              {request.identity.status === 'verified' ? '可执行' : '身份阻断'}
            </Badge>
          </Flex>
          {currentTask ? (
            <VStack align="stretch" spacing="3">
              <Text fontWeight="600">{currentTask.name}</Text>
              <Text color="gray.600" fontSize="sm">
                责任人：{currentTask.assignee}
              </Text>
              {currentTask.id.includes('-execute-') ? (
                <Alert status="info" borderRadius="5px" fontSize="sm">
                  执行类任务以系统回执为准完成，请用“登记回执”登记成功或冲突结果。
                </Alert>
              ) : null}
              <Button
                size="sm"
                colorScheme="brand"
                isDisabled={request.identity.status !== 'verified'}
                onClick={() => void taskMutation(currentTask, 'start')}
              >
                开始任务
              </Button>
              {currentTask.id.includes('-execute-') ? (
                <Button
                  size="sm"
                  colorScheme="orange"
                  isDisabled={request.identity.status !== 'verified'}
                  onClick={() => openDialog('receipt', currentTask)}
                >
                  登记系统回执
                </Button>
              ) : (
                <Button
                  size="sm"
                  colorScheme="green"
                  isDisabled={request.identity.status !== 'verified'}
                  onClick={() => void taskMutation(currentTask, 'complete')}
                >
                  完成任务
                </Button>
              )}
              <Button
                size="sm"
                colorScheme="red"
                variant="outline"
                onClick={() => openDialog('block', currentTask)}
              >
                阻断并复核
              </Button>
            </VStack>
          ) : (
            <Alert status="success" borderRadius="5px">
              当前没有活动任务，可核对回执、冲突与合并状态。
            </Alert>
          )}
          <Divider my="4" />
          <VStack align="stretch" spacing="2">
            <Button size="sm" onClick={() => openDialog('conflict')} leftIcon={<Link2Off size={15} />}>
              标记冲突或例外
            </Button>
            <Button size="sm" onClick={() => openDialog('extend')} leftIcon={<ShieldAlert size={15} />}>
              申请延期
            </Button>
          </VStack>
        </Box>

        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">履约任务</Heading>
            <Text color="gray.500" fontSize="sm">
              {completedTasks} / {request.tasks.length} 完成
            </Text>
          </Flex>
          <VStack align="stretch" spacing="0">
            {request.tasks.map((task) => (
              <Box
                key={task.id}
                className={`timeline-item ${task.status === 'active' ? 'active' : ''} ${task.status === 'blocked' ? 'blocked' : ''}`}
              >
                <Flex justify="space-between" gap="4">
                  <Box>
                    <HStack>
                      <Badge>{task.order}</Badge>
                      <Text fontWeight="600">{task.name}</Text>
                    </HStack>
                    <Text mt="1" color="gray.600" fontSize="sm">
                      {task.role} · {task.assignee}
                    </Text>
                    {task.exceptionReason ? (
                      <Text mt="1" color="red.600" fontSize="sm">
                        {task.exceptionReason}
                      </Text>
                    ) : null}
                  </Box>
                  <VStack align="flex-end" spacing="2">
                    <Badge
                      colorScheme={
                        task.status === 'completed'
                          ? 'green'
                          : task.status === 'active'
                            ? 'blue'
                            : task.status === 'blocked'
                              ? 'red'
                              : 'gray'
                      }
                    >
                      {task.status === 'completed'
                        ? '已完成'
                        : task.status === 'active'
                          ? '执行中'
                          : task.status === 'blocked'
                            ? '已阻断'
                            : '未开始'}
                    </Badge>
                    <HStack spacing="1">
                      <Button size="xs" variant="ghost" onClick={() => openDialog('assign', task)}>
                        分派
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => openDialog('evidence', task)}>
                        证据
                      </Button>
                      {task.id.includes('-execute-') && task.status !== 'completed' ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          colorScheme="orange"
                          onClick={() => openDialog('receipt', task)}
                        >
                          回执
                        </Button>
                      ) : null}
                    </HStack>
                  </VStack>
                </Flex>
              </Box>
            ))}
          </VStack>
        </Box>

        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">冲突复核与证据</Heading>
            <Badge colorScheme={unresolvedConflicts.length ? 'red' : 'green'}>
              {unresolvedConflicts.length} 项待复核
            </Badge>
          </Flex>
          <VStack align="stretch" spacing="3">
            {request.conflicts.map((conflict) => (
              <Alert
                key={conflict.id}
                status={conflict.resolved ? 'success' : 'error'}
                borderRadius="5px"
                flexDirection="column"
                alignItems="flex-start"
              >
                <Text fontSize="sm">{conflict.description}</Text>
                {conflict.resolved ? (
                  <Box mt="1">
                    <Badge colorScheme="green">
                      已复核 · {conflict.resolvedBy} ·{' '}
                      {conflict.resolvedAt && new Date(conflict.resolvedAt).toLocaleDateString('zh-CN')}
                    </Badge>
                    <Text mt="1" color="gray.600" fontSize="xs">
                      结论：{conflict.resolution}
                    </Text>
                  </Box>
                ) : (
                  <Button
                    mt="2"
                    size="xs"
                    variant="outline"
                    colorScheme="red"
                    onClick={() => openDialog('resolve', undefined, conflict)}
                  >
                    记录复核结论
                  </Button>
                )}
              </Alert>
            ))}
            {!request.conflicts.length ? (
              <Alert status="success" borderRadius="5px">
                当前没有未解决冲突。
              </Alert>
            ) : null}
          </VStack>
          <Divider my="4" />
          <Heading size="xs" mb="3">
            执行证据
          </Heading>
          <VStack align="stretch" spacing="2">
            {request.evidence.map((evidence) => (
              <Box key={evidence.id} className="timeline-item">
                <HStack>
                  <Text fontWeight="600">{evidence.name}</Text>
                  {evidence.receiptKey ? <Badge colorScheme="teal">回执证据</Badge> : null}
                </HStack>
                <Text mt="1" color="gray.600" fontSize="xs">
                  {evidence.evidenceType} · {evidence.digest}
                  {evidence.receiptKey ? ` · ${evidence.receiptKey}` : ''}
                </Text>
                <Text mt="1" color="gray.500" fontSize="xs">
                  {evidence.uploadedBy} · {new Date(evidence.uploadedAt).toLocaleString('zh-CN')}
                </Text>
              </Box>
            ))}
            {!request.evidence.length ? (
              <Text color="gray.500" fontSize="sm">
                暂无执行证据。
              </Text>
            ) : null}
          </VStack>
        </Box>
      </div>

      <div className="two-column">
        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">处理意见</Heading>
          </Flex>
          <HStack align="flex-start" mb="3">
            <Textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="填写跨系统处理说明、例外分析或补充要求"
            />
            <Button
              colorScheme="brand"
              isDisabled={!content.trim()}
              isLoading={addComment.isPending}
              onClick={async () => {
                try {
                  await addComment.mutateAsync({
                    requestId,
                    content: content.trim(),
                    operator: '隐私运营',
                  })
                  setContent('')
                  toast({ title: '处理意见已记录', status: 'success' })
                } catch (error) {
                  failToast(error, '意见提交失败')
                }
              }}
            >
              提交意见
            </Button>
          </HStack>
          <VStack align="stretch" spacing="2">
            {comments.map((comment) => (
              <Box key={comment.id} className="summary-box">
                <Text>{comment.content}</Text>
                <Text mt="2" color="gray.500" fontSize="xs">
                  {comment.author} · {new Date(comment.createdAt).toLocaleString('zh-CN')}
                </Text>
              </Box>
            ))}
          </VStack>
        </Box>

        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">操作审计</Heading>
            <Badge>{request.audit.length} 条</Badge>
          </Flex>
          <VStack align="stretch" spacing="2" maxH="360px" overflowY="auto">
            {request.audit.map((entry) => (
              <Box key={entry.id} className="timeline-item">
                <Text fontWeight="600">{entry.action}</Text>
                <Text mt="1" color="gray.600" fontSize="sm">
                  {entry.detail}
                </Text>
                <Text mt="1" color="gray.500" fontSize="xs">
                  {entry.operator} · {new Date(entry.createdAt).toLocaleString('zh-CN')}
                </Text>
              </Box>
            ))}
          </VStack>
        </Box>
      </div>

      <Modal isOpen={isOpen} onClose={onClose} size={dialog === 'receipt' || dialog === 'edit' ? 'xl' : 'lg'}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{dialog ? dialogTitle[dialog] : ''}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            {dialog === 'edit' ? (
              <VStack align="stretch" spacing="4">
                <FormControl isRequired>
                  <FormLabel>请求人</FormLabel>
                  <Input
                    value={editForm.requesterName}
                    onChange={(event) =>
                      setEditForm({ ...editForm, requesterName: event.target.value })
                    }
                  />
                </FormControl>
                <FormControl isRequired>
                  <FormLabel>联系方式</FormLabel>
                  <Input
                    value={editForm.requesterContact}
                    onChange={(event) =>
                      setEditForm({ ...editForm, requesterContact: event.target.value })
                    }
                  />
                </FormControl>
                <Alert status="info" borderRadius="5px">
                  地区 {regionLabels[request.region]}、请求类型 {requestTypeLabels[request.type]}、
                  涉及系统与期限模板（{request.deadlineTemplate?.version}）在登记时冻结，不能整包覆盖；
                  如需变更请新登记请求。
                </Alert>
              </VStack>
            ) : null}

            {dialog === 'identity' ? (
              <VStack align="stretch" spacing="4">
                <FormControl>
                  <FormLabel>核验结论</FormLabel>
                  <Select
                    value={identityStatus}
                    onChange={(event) =>
                      setIdentityStatus(event.target.value as 'verified' | 'insufficient')
                    }
                  >
                    <option value="verified">核验通过</option>
                    <option value="insufficient">材料不足，进入复核</option>
                  </Select>
                </FormControl>
                <FormControl isRequired>
                  <FormLabel>核验说明</FormLabel>
                  <Textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    placeholder="说明核验依据、材料保护方式或不足项"
                  />
                </FormControl>
              </VStack>
            ) : null}

            {dialog === 'assign' && selectedTask ? (
              <FormControl isRequired>
                <FormLabel>责任人或团队</FormLabel>
                <Input value={assignee} onChange={(event) => setAssignee(event.target.value)} />
              </FormControl>
            ) : null}

            {dialog === 'receipt' ? (
              <VStack align="stretch" spacing="4">
                <Alert status="info" borderRadius="5px">
                  超时重发请沿用同一回执编号（幂等键）并勾选“重发”：系统按同一笔认，只追加重发记录，
                  不会重复生成证据，也不会覆盖其他系统刚保存的结果。
                </Alert>
                <FormControl isRequired>
                  <FormLabel>来源系统</FormLabel>
                  <Select
                    value={receiptForm.systemId}
                    onChange={(event) =>
                      setReceiptForm({ ...receiptForm, systemId: event.target.value })
                    }
                  >
                    {systems.map((system) => (
                      <option key={system.id} value={system.id}>
                        {system.name}
                        {receiptBySystem.get(system.id) ? '（已有回执，重发请用同一编号）' : ''}
                      </option>
                    ))}
                  </Select>
                </FormControl>
                <Flex gap="4">
                  <FormControl isRequired>
                    <FormLabel>回执编号（幂等键）</FormLabel>
                    <Input
                      value={receiptForm.idempotencyKey}
                      onChange={(event) =>
                        setReceiptForm({ ...receiptForm, idempotencyKey: event.target.value })
                      }
                      placeholder="例如 RC-001-CRM-77"
                    />
                  </FormControl>
                  <FormControl>
                    <FormLabel>回执结果</FormLabel>
                    <Select
                      value={receiptForm.outcome}
                      onChange={(event) =>
                        setReceiptForm({
                          ...receiptForm,
                          outcome: event.target.value as 'success' | 'conflict',
                        })
                      }
                    >
                      <option value="success">处理成功</option>
                      <option value="conflict">结果与其他系统冲突</option>
                    </Select>
                  </FormControl>
                </Flex>
                <FormControl isRequired>
                  <FormLabel>回执结果摘要</FormLabel>
                  <Textarea
                    value={receiptForm.payloadSummary}
                    onChange={(event) =>
                      setReceiptForm({ ...receiptForm, payloadSummary: event.target.value })
                    }
                    placeholder="仅记录结果摘要，不保存原始数据"
                  />
                </FormControl>
                <Checkbox
                  isChecked={receiptForm.isResend}
                  onChange={(event) =>
                    setReceiptForm({ ...receiptForm, isResend: event.target.checked })
                  }
                >
                  这是超时后的重发回执（同一编号、同一笔）
                </Checkbox>
              </VStack>
            ) : null}

            {dialog === 'merge' ? (
              <VStack align="stretch" spacing="4">
                <Alert status="success" borderRadius="5px">
                  {systems.length} 个系统的回执均已接受，合并将基于这些已接受回执，
                  不接受任何系统的整包覆盖。
                </Alert>
                <FormControl isRequired>
                  <FormLabel>合并说明</FormLabel>
                  <Textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    placeholder="说明各系统结果一致性核对与最终合并结论"
                  />
                </FormControl>
              </VStack>
            ) : null}

            {dialog === 'evidence' && selectedTask ? (
              <VStack align="stretch" spacing="4">
                <Alert status="info" borderRadius="5px">
                  证据只登记名称、类型、摘要和时间，不保存原附件内容；系统回执请改用“登记回执”。
                </Alert>
                <FormControl isRequired>
                  <FormLabel>证据名称</FormLabel>
                  <Input
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    placeholder="例如 删除执行日志"
                  />
                </FormControl>
                <FormControl>
                  <FormLabel>证据类型</FormLabel>
                  <Select
                    value={evidenceType}
                    onChange={(event) =>
                      setEvidenceType(
                        event.target.value as
                          | 'execution-log'
                          | 'screenshot'
                          | 'signed-record'
                          | 'system-response',
                      )
                    }
                  >
                    <option value="execution-log">执行日志</option>
                    <option value="screenshot">截图</option>
                    <option value="signed-record">签署记录</option>
                    <option value="system-response">系统回执</option>
                  </Select>
                </FormControl>
              </VStack>
            ) : null}

            {['block', 'conflict', 'resolve', 'close'].includes(dialog ?? '') ? (
              <FormControl isRequired>
                <FormLabel>
                  {dialog === 'close'
                    ? '结果关闭说明'
                    : dialog === 'resolve'
                      ? '复核结论（逐项记录复核人与时间）'
                      : '原因与说明'}
                </FormLabel>
                <Textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder={
                    dialog === 'close'
                      ? '说明各系统回执、合并结论、保留例外和最终结论'
                      : '填写可审计的原因和处理依据'
                  }
                />
              </FormControl>
            ) : null}

            {dialog === 'extend' ? (
              <VStack align="stretch" spacing="4">
                <FormControl isRequired>
                  <FormLabel>延期天数</FormLabel>
                  <Input
                    type="number"
                    min={1}
                    max={90}
                    value={extendDays}
                    onChange={(event) => setExtendDays(Number(event.target.value))}
                  />
                </FormControl>
                <FormControl isRequired>
                  <FormLabel>延期原因</FormLabel>
                  <Textarea value={content} onChange={(event) => setContent(event.target.value)} />
                </FormControl>
              </VStack>
            ) : null}
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr="3" onClick={onClose}>
              取消
            </Button>
            <Button
              colorScheme="brand"
              isLoading={registerReceipt.isPending || mergeResults.isPending}
              onClick={submitDialog}
            >
              确认提交
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  )
}
