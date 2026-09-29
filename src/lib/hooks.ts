'use client'

import { useEffect } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query'
import { trpc } from './trpc'
import { loadWorkspace, saveWorkspace, subscribeWorkspace } from './localStore'
import type { PrivacyRequest, WorkspaceState } from '@/types/domain'

export const workspaceQueryKey = ['privacy-workspace'] as const

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

  useEffect(() => {
    if (query.data) saveWorkspace(query.data)
  }, [query.data])

  // 其他标签页/系统写入整包状态后立刻同步：本页面之后的处理动作会绑定新版本
  useEffect(() => subscribeWorkspace((state) => {
    queryClient.setQueryData(workspaceQueryKey, state)
  }), [queryClient])

  return query
}

function useWorkspaceMutation<TInput>(
  perform: (input: TInput, state: WorkspaceState) => Promise<WorkspaceState>,
): UseMutationResult<WorkspaceState, Error, TInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: TInput) => {
      // 始终取最新整包（含其他标签页刚写入的版本），处理动作携带的 expectedVersion 由调用方绑定
      const state = loadWorkspace() ?? queryClient.getQueryData<WorkspaceState>(workspaceQueryKey)
      if (!state) throw new Error('本地工作区尚未加载')
      return perform(input, state)
    },
    onSuccess: (state) => {
      saveWorkspace(state)
      queryClient.setQueryData(workspaceQueryKey, state)
    },
  })
}

type WithoutState<T> = Omit<T, 'state'>

export function useCreateRequestMutation() {
  return useWorkspaceMutation(
    (input: WithoutState<Parameters<typeof trpc.request.create.mutate>[0]>, state) =>
      trpc.request.create.mutate({ ...input, state }),
  )
}

export function useSaveRequestMutation() {
  return useWorkspaceMutation(
    (input: WithoutState<Parameters<typeof trpc.request.save.mutate>[0]>, state) =>
      trpc.request.save.mutate({ ...input, state }),
  )
}

export function useVerifyIdentityMutation() {
  return useWorkspaceMutation(
    (input: WithoutState<Parameters<typeof trpc.request.verifyIdentity.mutate>[0]>, state) =>
      trpc.request.verifyIdentity.mutate({ ...input, state }),
  )
}

export function useAssignTaskMutation() {
  return useWorkspaceMutation(
    (input: WithoutState<Parameters<typeof trpc.request.assignTask.mutate>[0]>, state) =>
      trpc.request.assignTask.mutate({ ...input, state }),
  )
}

export function useTaskActionMutation() {
  return useWorkspaceMutation(
    (input: WithoutState<Parameters<typeof trpc.request.taskAction.mutate>[0]>, state) =>
      trpc.request.taskAction.mutate({ ...input, state }),
  )
}

export function useAddEvidenceMutation() {
  return useWorkspaceMutation(
    (input: WithoutState<Parameters<typeof trpc.request.addEvidence.mutate>[0]>, state) =>
      trpc.request.addEvidence.mutate({ ...input, state }),
  )
}

export function useRegisterReceiptMutation() {
  return useWorkspaceMutation(
    (input: WithoutState<Parameters<typeof trpc.request.registerReceipt.mutate>[0]>, state) =>
      trpc.request.registerReceipt.mutate({ ...input, state }),
  )
}

export function useAddConflictMutation() {
  return useWorkspaceMutation(
    (input: WithoutState<Parameters<typeof trpc.request.addConflict.mutate>[0]>, state) =>
      trpc.request.addConflict.mutate({ ...input, state }),
  )
}

export function useResolveConflictMutation() {
  return useWorkspaceMutation(
    (input: WithoutState<Parameters<typeof trpc.request.resolveConflict.mutate>[0]>, state) =>
      trpc.request.resolveConflict.mutate({ ...input, state }),
  )
}

export function useExtendRequestMutation() {
  return useWorkspaceMutation(
    (input: WithoutState<Parameters<typeof trpc.request.extend.mutate>[0]>, state) =>
      trpc.request.extend.mutate({ ...input, state }),
  )
}

export function useCloseRequestMutation() {
  return useWorkspaceMutation(
    (input: WithoutState<Parameters<typeof trpc.request.close.mutate>[0]>, state) =>
      trpc.request.close.mutate({ ...input, state }),
  )
}

export function useAddCommentMutation() {
  return useWorkspaceMutation(
    (input: WithoutState<Parameters<typeof trpc.request.comment.mutate>[0]>, state) =>
      trpc.request.comment.mutate({ ...input, state }),
  )
}

export function useRecordExportMutation() {
  return useWorkspaceMutation(
    (input: WithoutState<Parameters<typeof trpc.request.recordExport.mutate>[0]>, state) =>
      trpc.request.recordExport.mutate({ ...input, state }),
  )
}

export type { PrivacyRequest }
