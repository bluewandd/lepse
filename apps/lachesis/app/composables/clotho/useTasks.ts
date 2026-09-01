import { useMutation, useQuery } from '@tanstack/vue-query'
import { accountMutationScope, accountQueryKey, accountQueryOptions } from '~/lib/auth-cache'

export const useTasks = () => {
  const { $api, $queryClient, $authToken, $authScope, $authLifecycle } = useNuxtApp()

  const tasksQueryKey = accountQueryKey($api.tasks.index.queryKey(), $authScope)
  const tasksQuery = useQuery(
    accountQueryOptions($api.tasks.index.queryOptions(), $authScope, $authToken)
  )
  const tasks = computed(() =>
    $authLifecycle.isIdentityValidated.value ? tasksQuery.data.value?.data : undefined
  )
  const focusedTaskId = useState<number>('focusedTaskId', () => -1)

  const createTaskMutation = useMutation(
    $api.tasks.store.mutationOptions({
      onMutate: () => ({ accountScope: $authScope.value }),
      onSuccess: ({ data }, _variables, context) => {
        if (!$authLifecycle.isCurrentScope(accountMutationScope(context))) return
        $queryClient.setQueryData(
          tasksQueryKey.value,
          (old) => old && { ...old, data: [...old.data.filter((i) => i.id !== data.id), data] }
        )
      },
    })
  )

  const updateTaskMutation = useMutation(
    $api.tasks.update.mutationOptions({
      onMutate: () => ({ accountScope: $authScope.value }),
      onSuccess: ({ data }, _variables, context) => {
        if (!$authLifecycle.isCurrentScope(accountMutationScope(context))) return
        $queryClient.setQueryData(
          tasksQueryKey.value,
          (old) => old && { ...old, data: [...old.data.filter((i) => i.id !== data.id), data] }
        )
      },
    })
  )

  const destroyTaskMutation = useMutation(
    $api.tasks.destroy.mutationOptions({
      onMutate: () => ({ accountScope: $authScope.value }),
      onSuccess: (_, { params: { id } }, context) => {
        if (!$authLifecycle.isCurrentScope(accountMutationScope(context))) return
        $queryClient.setQueryData(
          tasksQueryKey.value,
          (old) => old && { ...old, data: old.data.filter((i) => i.id !== id) }
        )
      },
    })
  )

  const attachGoalMutation = useMutation(
    $api.tasks.attachGoal.mutationOptions({
      onMutate: () => ({ accountScope: $authScope.value }),
      onSuccess: ({ data }, _variables, context) => {
        if (!$authLifecycle.isCurrentScope(accountMutationScope(context))) return
        $queryClient.setQueryData(
          tasksQueryKey.value,
          (old) => old && { ...old, data: [...old.data.filter((i) => i.id !== data.id), data] }
        )
      },
    })
  )

  const detachGoalMutation = useMutation(
    $api.tasks.attachGoal.mutationOptions({
      onMutate: () => ({ accountScope: $authScope.value }),
      onSuccess: ({ data }, _variables, context) => {
        if (!$authLifecycle.isCurrentScope(accountMutationScope(context))) return
        $queryClient.setQueryData(
          tasksQueryKey.value,
          (old) => old && { ...old, data: [...old.data.filter((i) => i.id !== data.id), data] }
        )
      },
    })
  )

  return {
    tasksQuery,
    tasks,
    focusedTaskId,
    createTaskMutation,
    updateTaskMutation,
    destroyTaskMutation,
    attachGoalMutation,
    detachGoalMutation,
  }
}
