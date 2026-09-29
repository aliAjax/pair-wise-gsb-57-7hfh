'use client'

import { useMemo, useState } from 'react'
import NextLink from 'next/link'
import {
  Alert,
  Badge,
  Box,
  Button,
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
import { ArrowLeft, FileCheck2, Inbox, Link2Off, ShieldAlert } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { StatusBadge, TypeBadge } from '@/components/StatusBadge'
import {
  useAddCommentMutation,
  useAddConflictMutation,
  useAddEvidenceMutation,
  useAssignTaskMutation,
  useCloseRequestMutation,
  useExtendRequestMutation,
  useRegisterReceiptMutation,
  useResolveConflictMutation,
  useSaveRequestMutation,
  useTaskActionMutation,
  useVerifyIdentityMutation,
  useWorkspaceQuery,
} from '@/lib/hooks'
import {
  regionLabels,
  requestTypeLabels,
  type Region,
  type RequestType,
  type WorkflowStep,
} from '@/lib/schemas'
import { deadlineState, receiptStatus } from '@/services/workflow'
import type { DataSystem } from '@/types/domain'

type DialogType =
  | 'edit'
  | 'identity'
  | 'assign'
  | 'evidence'
  | 'receipt'
  | 'block'
  | 'conflict'
  | 'resolve'
  | 'extend'
  | 'close'
  | null

export function RequestDetailPage({ requestId }: { requestId: string }) {
  const { data, isLoading } = useWorkspaceQuery()
  const toast = useToast()
  const { isOpen, onOpen, onClose } = useDisclosure()
  const request = data?.requests.find((item) => item.id === requestId)
  const [dialog, setDialog] = useState<DialogType>(null)
  const [selectedTask, setSelectedTask] = useState<WorkflowStep>()
  const [selectedSystem, setSelectedSystem] = useState<DataSystem>()
  const [conflictIndex, setConflictIndex] = useState(0)
  const [content, setContent] = useState('')
  const [assignee, setAssignee] = useState('')
  const [identityStatus, setIdentityStatus] = useState<'verified' | 'insufficient'>('verified')
  const [evidenceType, setEvidenceType] = useState<
    'execution-log' | 'screenshot' | 'signed-record' | 'system-response'
  >('execution-log')
  const [receiptKey, setReceiptKey] = useState('')
  const [receiptResult, setReceiptResult] = useState<'accepted' | 'failed'>('accepted')
  const [extendDays, setExtendDays] = useState(15)
  const [editForm, setEditForm] = useState({
    requesterName: '',
    requesterContact: '',
    region: 'cn' as Region,
    type: 'access' as RequestType,
    affectedSystemIds: [] as string[],
  })

  const saveRequest = useSaveRequestMutation()
  const verifyIdentity = useVerifyIdentityMutation()
  const assignTask = useAssignTaskMutation()
  const taskAction = useTaskActionMutation()
  const addEvidence = useAddEvidenceMutation()
  const registerReceipt = useRegisterReceiptMutation()
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
  const receipt = receiptStatus(request)
  const receiptBySystem = new Map(
    request.systemReceipts.map((item) => [item.systemId, item]),
  )
  const blockedSystems = receipt.waitingSystems.filter((systemId) =>
    request.tasks.some(
      (task) => task.systemId === systemId && task.status === 'blocked',
    ),
  )
  const waitingSystems = receipt.waitingSystems.filter(
    (systemId) => !blockedSystems.includes(systemId),
  )

  function openDialog(
    type: DialogType,
    taskOrSystem?: WorkflowStep | DataSystem,
    index = 0,
  ) {
    if (!request) return
    if (type === 'receipt') {
      const system = taskOrSystem as DataSystem | undefined
      setSelectedSystem(system)
      const existing = system ? receiptBySystem.get(system.id) : undefined
      setReceiptKey(existing?.receiptKey ?? '')
      setReceiptResult(existing?.status === 'failed' ? 'failed' : 'accepted')
    } else {
      setSelectedTask(taskOrSystem as WorkflowStep | undefined)
    }
    setConflictIndex(index)
    setDialog(type)
    setContent('')
    if (type === 'assign') setAssignee((taskOrSystem as WorkflowStep)?.assignee ?? '')
    if (type === 'edit') {
      setEditForm({
        requesterName: request.requesterName,
        requesterContact: request.requesterContact,
        region: request.region,
        type: request.type,
        affectedSystemIds: [...request.affectedSystemIds],
      })
    }
    onOpen()
  }

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action()
      toast({ title: success, status: 'success' })
      onClose()
    } catch (error) {
      toast({
        title: '操作未完成',
        description: error instanceof Error ? error.message : '请检查输入和流程状态',
        status: 'error',
      })
    }
  }

  async function submitDialog() {
    if (!dialog || !request) return
    const expectedVersion = request.version
    if (dialog === 'edit') {
      await run(
        () =>
          saveRequest.mutateAsync({
            requestId,
            expectedVersion,
            patch: {
              requesterName: editForm.requesterName,
              requesterContact: editForm.requesterContact,
            },
            operator: '隐私运营',
          }),
        '请求信息已保存',
      )
    } else if (dialog === 'identity') {
      await run(
        () =>
          verifyIdentity.mutateAsync({
            requestId,
            expectedVersion,
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
            expectedVersion,
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
            expectedVersion,
            taskId: selectedTask.id,
            name: content,
            evidenceType,
            operator: '数据管理员',
          }),
        '执行证据已受保护登记',
      )
    } else if (dialog === 'receipt' && selectedSystem) {
      await run(
        () =>
          registerReceipt.mutateAsync({
            requestId,
            expectedVersion,
            systemId: selectedSystem.id,
            receiptKey: receiptKey.trim(),
            result: receiptResult,
            summary: content,
            note: '',
            operator: `${selectedSystem.owner}`,
          }),
        receiptResult === 'accepted' ? '回执已接受' : '失败回执已进入复核',
      )
    } else if (dialog === 'block' && selectedTask) {
      await run(
        () =>
          taskAction.mutateAsync({
            requestId,
            expectedVersion,
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
            expectedVersion,
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
            expectedVersion,
            conflictIndex,
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
            expectedVersion,
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
            expectedVersion,
            resultSummary: content,
            closureReason: deadline.overdue ? '' : '已完成全部系统任务，经复核后提前关闭。',
            operator: '隐私负责人',
          }),
        '请求已完成并关闭',
      )
    }
  }

  async function taskMutation(task: WorkflowStep, action: 'start' | 'complete') {
    if (!request) return
    try {
      await taskAction.mutateAsync({
        requestId,
        expectedVersion: request.version,
        taskId: task.id,
        action,
        note: action === 'start' ? '开始执行任务。' : '任务结果已提交。',
        operator: task.assignee || '数据管理员',
      })
      toast({ title: action === 'start' ? '任务已开始' : '任务已完成', status: 'success' })
    } catch (error) {
      toast({
        title: '任务状态未更新',
        description: error instanceof Error ? error.message : '请检查前置条件',
        status: 'error',
      })
    }
  }

  const dialogTitle: Record<Exclude<DialogType, null>, string> = {
    edit: '编辑请求基本信息（地区模板已冻结）',
    identity: '身份核验结论',
    assign: '分派履约任务',
    evidence: '登记执行证据',
    receipt: '登记系统处理回执',
    block: '阻断任务并说明原因',
    conflict: '新增冲突或例外',
    resolve: '记录冲突复核结论',
    extend: '延期处理请求',
    close: '关闭请求并合并结果',
  }

  return (
    <Box>
      <PageHeader
        title={`${request.code} · ${request.requesterName}`}
        description="身份核验、跨系统任务、证据、冲突复核、期限控制和结果合并均在当前工作区完成。"
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
            <Button colorScheme="brand" onClick={() => openDialog('close')}>
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
            数据版本 v{request.version} · 动作绑定当前版本
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
          <Text mt="1" color="gray.500" fontSize="xs">
            冻结模板 {request.deadlineTemplate.templateVersion} ·{' '}
            {request.deadlineTemplate.days} 日 · {request.extendedDays ? `已延期 ${request.extendedDays} 天` : '原期限'}
          </Text>
        </Box>
        <Box className="metric info">
          <Text color="gray.600" fontSize="sm">
            跨系统回执
          </Text>
          <Heading mt="2" size="md">
            {receipt.acceptedSystemIds.length} / {systems.length}
          </Heading>
          <Progress
            mt="2"
            size="sm"
            value={(receipt.acceptedSystemIds.length / Math.max(systems.length, 1)) * 100}
            colorScheme="brand"
          />
          <Text mt="1" color="gray.500" fontSize="xs">
            {receipt.allAccepted ? '回执已全部到齐，可合并' : `任务完成 ${completedTasks}/${request.tasks.length}`}
          </Text>
        </Box>
        <Box className={`metric ${request.conflicts.length || blockedSystems.length ? 'danger' : ''}`}>
          <Text color="gray.600" fontSize="sm">
            冲突与卡住系统
          </Text>
          <Heading mt="2" size="md">
            {request.conflicts.length} 项 / {blockedSystems.length} 个
          </Heading>
          <Text mt="1" color="gray.500" fontSize="xs">
            冲突未复核、回执未到齐均禁止关闭
          </Text>
        </Box>
      </SimpleGrid>

      {!receipt.allAccepted && request.identity.status === 'verified' ? (
        <Alert
          status={blockedSystems.length ? 'error' : 'warning'}
          mb="4"
          borderRadius="5px"
        >
          <VStack align="stretch" spacing="1">
            <Text>
              当前请求{blockedSystems.length ? '卡在' : '等待'}：
              {[...blockedSystems, ...waitingSystems]
                .map((systemId) => systems.find((system) => system.id === systemId)?.name ?? systemId)
                .join('、')}
              （回执 {receipt.acceptedSystemIds.length}/{systems.length}）。
            </Text>
            <Text fontSize="sm">
              {blockedSystems.length
                ? '上述系统任务阻断或回执失败，必须完成冲突复核并取得接受回执后才能合并。'
                : '上述系统尚未返回处理回执；全部回执到齐后才会激活跨系统结果合并。'}
            </Text>
          </VStack>
        </Alert>
      ) : null}
      {receipt.allAccepted && request.status !== 'completed' ? (
        <Alert status="success" mb="4" borderRadius="5px">
          全部 {systems.length} 个系统回执均已接受，可执行跨系统结果合并；重发回执按同一笔确认，不会重复生成证据。
        </Alert>
      ) : null}

      {request.conflicts.length ? (
        <Alert status="error" mb="4" borderRadius="5px">
          当前请求处于复核状态：{request.conflicts.join('；')}
        </Alert>
      ) : null}
      {request.duplicateOf ? (
        <Alert status="warning" mb="4" borderRadius="5px">
          系统检测到与 {request.duplicateOf} 疑似重复，已保留原请求证据并要求人工复核。
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
                地区与冻结模板
              </Text>
              <Text mt="1">
                {regionLabels[request.region]} · {requestTypeLabels[request.type]}
              </Text>
              <Text mt="1" color="gray.500" fontSize="xs">
                {request.deadlineTemplate.templateVersion} · 登记时冻结{' '}
                {request.deadlineTemplate.days} 日，新模板不影响本请求
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
            </Box>
          </HStack>
        </Box>

        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">跨系统回执（按回执编号幂等）</Heading>
            <Badge colorScheme="blue">
              {receipt.acceptedSystemIds.length}/{systems.length} 已接受
            </Badge>
          </Flex>
          <VStack align="stretch" spacing="3">
            {systems.map((system) => {
              const item = receiptBySystem.get(system.id)
              const blocked = blockedSystems.includes(system.id)
              const waiting = waitingSystems.includes(system.id)
              return (
                <Box key={system.id} p="3" bg={blocked ? 'red.50' : waiting ? 'orange.50' : 'gray.50'} borderRadius="5px">
                  <Flex justify="space-between" align="center">
                    <Box>
                      <Text fontWeight="600">{system.name}</Text>
                      <Text color="gray.600" fontSize="sm">
                        {system.owner} · {system.transferMethod}
                      </Text>
                    </Box>
                    {item ? (
                      <HStack>
                        <Badge colorScheme={item.status === 'accepted' ? 'green' : 'red'}>
                          {item.status === 'accepted' ? '回执已接受' : '回执失败'}
                        </Badge>
                        {item.deliveryCount > 1 ? (
                          <Badge colorScheme="purple">重发 ×{item.deliveryCount - 1}</Badge>
                        ) : null}
                      </HStack>
                    ) : blocked ? (
                      <Badge colorScheme="red">阻断 · 待复核</Badge>
                    ) : (
                      <Badge colorScheme="orange">等待回执</Badge>
                    )}
                  </Flex>
                  {item ? (
                    <Box mt="2">
                      <Text fontSize="sm" color="gray.700">
                        <span className="mono">{item.receiptKey}</span> · {item.summary}
                      </Text>
                      <Text mt="1" color="gray.500" fontSize="xs">
                        首次接受 {new Date(item.receivedAt).toLocaleString('zh-CN')} · 最近送达{' '}
                        {new Date(item.lastDeliveryAt).toLocaleString('zh-CN')} · 投递 {item.deliveryCount} 次
                      </Text>
                      {item.redeliveries.map((redelivery, index) => (
                        <Text key={index} mt="1" color="purple.700" fontSize="xs">
                          重发留痕：{new Date(redelivery.deliveredAt).toLocaleString('zh-CN')} ·{' '}
                          {redelivery.operator} · {redelivery.note}
                        </Text>
                      ))}
                      {item.status === 'accepted' ? (
                        <Button
                          mt="2"
                          size="xs"
                          variant="outline"
                          onClick={() => openDialog('receipt', system)}
                          leftIcon={<Inbox size={13} />}
                        >
                          模拟超时重发（同一回执编号）
                        </Button>
                      ) : null}
                    </Box>
                  ) : (
                    <Box mt="2">
                      <Text color={blocked ? 'red.600' : 'gray.600'} fontSize="sm">
                        {blocked
                          ? '该系统任务已阻断，失败回执进入复核，复核前请求不能关闭。'
                          : '该系统尚未返回回执，全部回执到齐前不能合并结果。'}
                      </Text>
                      <Button
                        mt="2"
                        size="xs"
                        colorScheme="brand"
                        isDisabled={request.identity.status !== 'verified'}
                        onClick={() => openDialog('receipt', system)}
                        leftIcon={<Inbox size={13} />}
                      >
                        登记回执
                      </Button>
                    </Box>
                  )}
                </Box>
              )
            })}
          </VStack>
          <Alert status="info" mt="4" borderRadius="5px">
            回执按“系统 + 回执编号”认定同一笔：超时重发只记录送达，不再生成证据、不推进任务；跨系统回执全部接受后才允许合并。
          </Alert>
        </Box>
      </div>

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
              <Button
                size="sm"
                colorScheme="brand"
                isDisabled={request.identity.status !== 'verified'}
                onClick={() => void taskMutation(currentTask, 'start')}
              >
                开始任务
              </Button>
              <Button
                size="sm"
                colorScheme="green"
                isDisabled={request.identity.status !== 'verified'}
                onClick={() => void taskMutation(currentTask, 'complete')}
              >
                完成任务
              </Button>
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
              当前没有活动任务，可检查冲突并关闭请求。
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
              {request.tasks.length} 项
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
                    {task.id.endsWith('-merge') && !receipt.allAccepted && task.status !== 'completed' ? (
                      <Text mt="1" color="orange.600" fontSize="sm">
                        跨系统回执 {receipt.acceptedSystemIds.length}/{systems.length}，未到齐不能合并。
                      </Text>
                    ) : null}
                    {task.id.endsWith('-review') && request.conflicts.length > 0 && task.status !== 'completed' ? (
                      <Text mt="1" color="red.600" fontSize="sm">
                        尚有 {request.conflicts.length} 项冲突未复核，不能完成复核步骤。
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
            <Badge colorScheme={request.conflicts.length ? 'red' : 'green'}>
              {request.conflicts.length} 项冲突
            </Badge>
          </Flex>
          <VStack align="stretch" spacing="3">
            {request.conflicts.map((conflict, index) => (
              <Alert key={`${conflict}-${index}`} status="error" borderRadius="5px">
                <Text fontSize="sm">{conflict}</Text>
                <Button
                  mt="2"
                  size="xs"
                  variant="outline"
                  colorScheme="red"
                  onClick={() => openDialog('resolve', undefined, index)}
                >
                  记录复核结论
                </Button>
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
                  <Badge
                    colorScheme={
                      evidence.source === 'receipt'
                        ? 'green'
                        : evidence.source === 'legacy-backfill'
                          ? 'purple'
                          : 'gray'
                    }
                  >
                    {evidence.source === 'receipt'
                      ? '回执接受生成'
                      : evidence.source === 'legacy-backfill'
                        ? '旧数据补齐'
                        : '人工登记'}
                  </Badge>
                </HStack>
                <Text mt="1" color="gray.600" fontSize="xs">
                  {evidence.evidenceType} · {evidence.digest}
                  {evidence.receiptKey ? <> · <span className="mono">{evidence.receiptKey}</span></> : null}
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
                    expectedVersion: request.version,
                    content: content.trim(),
                    operator: '隐私运营',
                  })
                  setContent('')
                  toast({ title: '处理意见已记录', status: 'success' })
                } catch (error) {
                  toast({
                    title: '意见提交失败',
                    description: error instanceof Error ? error.message : '请重试',
                    status: 'error',
                  })
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

      <Modal isOpen={isOpen} onClose={onClose} size={dialog === 'edit' ? 'xl' : 'lg'}>
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
                <Flex gap="4">
                  <FormControl>
                    <FormLabel>地区（登记时冻结，不可改）</FormLabel>
                    <Input value={regionLabels[editForm.region]} isReadOnly bg="gray.50" />
                  </FormControl>
                  <FormControl>
                    <FormLabel>请求类型（登记时冻结，不可改）</FormLabel>
                    <Input value={requestTypeLabels[editForm.type]} isReadOnly bg="gray.50" />
                  </FormControl>
                </Flex>
                <FormControl>
                  <FormLabel>相关系统（登记时冻结，不可改）</FormLabel>
                  <HStack wrap="wrap">
                    {data.systems
                      .filter((system) => editForm.affectedSystemIds.includes(system.id))
                      .map((system) => (
                        <Badge key={system.id} colorScheme="blue" fontSize="sm">
                          {system.name}
                        </Badge>
                      ))}
                  </HStack>
                </FormControl>
                <Alert status="info" borderRadius="5px">
                  期限按登记时地区模板冻结（{request.deadlineTemplate.templateVersion}，
                  {request.deadlineTemplate.days} 日）；新模板只影响之后登记的请求。如需变更地区、类型或系统范围，请重新登记请求。
                </Alert>
              </VStack>
            ) : null}

            {dialog === 'receipt' && selectedSystem ? (
              <VStack align="stretch" spacing="4">
                <Alert status="info" borderRadius="5px">
                  {selectedSystem.name}：回执编号是幂等键。超时重发请保持同一编号，系统按同一笔确认，不会重复生成证据。
                </Alert>
                <FormControl isRequired>
                  <FormLabel>系统回执编号（幂等键）</FormLabel>
                  <Input
                    value={receiptKey}
                    onChange={(event) => setReceiptKey(event.target.value)}
                    placeholder="例如 RCP-CRM-0929-201"
                  />
                </FormControl>
                <FormControl>
                  <FormLabel>回执结果</FormLabel>
                  <Select
                    value={receiptResult}
                    onChange={(event) =>
                      setReceiptResult(event.target.value as 'accepted' | 'failed')
                    }
                  >
                    <option value="accepted">处理完成（接受，生成回执证据并推进任务）</option>
                    <option value="failed">处理失败/例外（进入冲突复核，不允许关闭）</option>
                  </Select>
                </FormControl>
                <FormControl isRequired>
                  <FormLabel>处理结果说明</FormLabel>
                  <Textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    placeholder="说明该系统的实际处理结果、数据范围或失败原因"
                  />
                </FormControl>
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

            {dialog === 'evidence' && selectedTask ? (
              <VStack align="stretch" spacing="4">
                <Alert status="info" borderRadius="5px">
                  证据只登记名称、类型、摘要和时间，不保存原附件内容。
                </Alert>
                <FormControl isRequired>
                  <FormLabel>证据名称</FormLabel>
                  <Input
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    placeholder="例如 删除执行回执"
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
                <FormLabel>{dialog === 'close' ? '结果合并说明' : '原因与说明'}</FormLabel>
                <Textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder={
                    dialog === 'close'
                      ? '说明各系统处理结果、保留的例外和最终结论'
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
            <Button colorScheme="brand" onClick={submitDialog}>
              确认提交
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  )
}
