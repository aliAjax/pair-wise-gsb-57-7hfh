'use client'

import { useEffect } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query'
import { TRPCClientError } from '@trpc/client'
import { trpc } from './trpc'
import { loadWorkspace, saveWorkspace } from './localStore'
import { assertSnapshotFresh, readPersistedRevision, StaleVersionError } from './concurrency'
import type { WorkspaceState } from '@/types/domain'

export const workspaceQueryKey = ['privacy-workspace'] as const
const STORAGE_KEY = 'privacy-rights-workbench-v1'

/** 错误是否为“工作区版本过期”（其他页面/系统先完成了保存）。 */
export function isVersionConflictError(error: unknown): boolean {
  if (error instanceof StaleVersionError) return true
  if (error instanceof TRPCClientError) {
    return (error.data as { code?: string } | undefined)?.code === 'CONFLICT'
  }
  return error instanceof Error && error.name === 'VersionConflictError'
}

export function useWorkspaceQuery() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: workspaceQueryKey,
    queryFn: () => trpc.workspace.defaults.query(),
    staleTime: Number.POSITIVE_INFINITY,
  })

  useEffect(() => {
    const cached = loadWorkspace()
    if (cached) queryClient.setQueryData(workspaceQueryKey, cached)
  }, [queryClient])

  // 跨标签页同步：另一个页面整包保存后，本页面立刻拿到最新版本，
  // 后续动作绑定新版本，避免用旧 revision 覆盖对方的任务与审计。
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== STORAGE_KEY || !event.newValue) return
      try {
        const next = loadWorkspace()
        if (next) queryClient.setQueryData(workspaceQueryKey, next)
      } catch {
        // 忽略无法解析的存储内容
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [queryClient])

  useEffect(() => {
    if (query.data) saveWorkspace(query.data)
  }, [query.data])

  return query
}

/**
 * 所有变更动作自动绑定当前工作区版本：提交时把最新 revision 作为
 * expectedRevision 一并发送，服务端失配即拒绝整包保存。
 */
function useWorkspaceMutation<TInput, TOutput = WorkspaceState>(
  perform: (input: TInput, state: WorkspaceState, expectedRevision: number) => Promise<TOutput>,
  onPersist?: (output: TOutput) => WorkspaceState | undefined,
): UseMutationResult<TOutput, Error, TInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: TInput) => {
      const state =
        queryClient.getQueryData<WorkspaceState>(workspaceQueryKey) ?? loadWorkspace()
      if (!state) throw new Error('本地工作区尚未加载')
      // 动作绑定当前版本：其他标签页/系统已先行保存时，持久化版本会更新，
      // 此处立即拒绝基于旧版本的整包写入，避免覆盖对方刚完成的任务与审计。
      const persistedRevision = readPersistedRevision()
      assertSnapshotFresh(state.revision, persistedRevision)
      return perform(input, state, state.revision)
    },
    onSuccess: (output) => {
      const next = onPersist ? onPersist(output) : (output as WorkspaceState)
      if (next) {
        saveWorkspace(next)
        queryClient.setQueryData(workspaceQueryKey, next)
      }
    },
  })
}

type MutationInput<T> = Omit<T, 'state' | 'expectedRevision'>

export function useCreateRequestMutation() {
  return useWorkspaceMutation(
    (input: MutationInput<Parameters<typeof trpc.request.create.mutate>[0]>, state, expectedRevision) =>
      trpc.request.create.mutate({ ...input, state, expectedRevision }),
  )
}

export function useSaveRequestMutation() {
  return useWorkspaceMutation(
    (input: MutationInput<Parameters<typeof trpc.request.save.mutate>[0]>, state, expectedRevision) =>
      trpc.request.save.mutate({ ...input, state, expectedRevision }),
  )
}

export function useVerifyIdentityMutation() {
  return useWorkspaceMutation(
    (input: MutationInput<Parameters<typeof trpc.request.verifyIdentity.mutate>[0]>, state, expectedRevision) =>
      trpc.request.verifyIdentity.mutate({ ...input, state, expectedRevision }),
  )
}

export function useAssignTaskMutation() {
  return useWorkspaceMutation(
    (input: MutationInput<Parameters<typeof trpc.request.assignTask.mutate>[0]>, state, expectedRevision) =>
      trpc.request.assignTask.mutate({ ...input, state, expectedRevision }),
  )
}

export function useTaskActionMutation() {
  return useWorkspaceMutation(
    (input: MutationInput<Parameters<typeof trpc.request.taskAction.mutate>[0]>, state, expectedRevision) =>
      trpc.request.taskAction.mutate({ ...input, state, expectedRevision }),
  )
}

export function useAddEvidenceMutation() {
  return useWorkspaceMutation(
    (input: MutationInput<Parameters<typeof trpc.request.addEvidence.mutate>[0]>, state, expectedRevision) =>
      trpc.request.addEvidence.mutate({ ...input, state, expectedRevision }),
  )
}

export interface RegisterReceiptOutput {
  state: WorkspaceState
  duplicate: boolean
}

export function useRegisterReceiptMutation() {
  return useWorkspaceMutation(
    async (
      input: MutationInput<Parameters<typeof trpc.request.registerReceipt.mutate>[0]>,
      state,
      expectedRevision,
    ) => {
      const result = await trpc.request.registerReceipt.mutate({
        ...input,
        state,
        expectedRevision,
      })
      return { state: result.state, duplicate: result.duplicate } satisfies RegisterReceiptOutput
    },
    (output) => output.state,
  )
}

export function useMergeResultsMutation() {
  return useWorkspaceMutation(
    (input: MutationInput<Parameters<typeof trpc.request.merge.mutate>[0]>, state, expectedRevision) =>
      trpc.request.merge.mutate({ ...input, state, expectedRevision }),
  )
}

export function useAddConflictMutation() {
  return useWorkspaceMutation(
    (input: MutationInput<Parameters<typeof trpc.request.addConflict.mutate>[0]>, state, expectedRevision) =>
      trpc.request.addConflict.mutate({ ...input, state, expectedRevision }),
  )
}

export function useResolveConflictMutation() {
  return useWorkspaceMutation(
    (input: MutationInput<Parameters<typeof trpc.request.resolveConflict.mutate>[0]>, state, expectedRevision) =>
      trpc.request.resolveConflict.mutate({ ...input, state, expectedRevision }),
  )
}

export function useExtendRequestMutation() {
  return useWorkspaceMutation(
    (input: MutationInput<Parameters<typeof trpc.request.extend.mutate>[0]>, state, expectedRevision) =>
      trpc.request.extend.mutate({ ...input, state, expectedRevision }),
  )
}

export function useCloseRequestMutation() {
  return useWorkspaceMutation(
    (input: MutationInput<Parameters<typeof trpc.request.close.mutate>[0]>, state, expectedRevision) =>
      trpc.request.close.mutate({ ...input, state, expectedRevision }),
  )
}

export function useAddCommentMutation() {
  return useWorkspaceMutation(
    (input: MutationInput<Parameters<typeof trpc.request.comment.mutate>[0]>, state, expectedRevision) =>
      trpc.request.comment.mutate({ ...input, state, expectedRevision }),
  )
}

export function useRecordExportMutation() {
  return useWorkspaceMutation(
    (input: MutationInput<Parameters<typeof trpc.request.recordExport.mutate>[0]>, state, expectedRevision) =>
      trpc.request.recordExport.mutate({ ...input, state, expectedRevision }),
  )
}
