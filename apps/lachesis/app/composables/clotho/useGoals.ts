import { useMutation, useQuery } from '@tanstack/vue-query'
import { accountMutationScope, accountQueryKey, accountQueryOptions } from '~/lib/auth-cache'

export const useGoals = () => {
  const { $api, $queryClient, $authToken, $authScope, $authLifecycle } = useNuxtApp()

  const goalsQueryKey = accountQueryKey($api.goals.index.queryKey(), $authScope)
  const goalsQuery = useQuery(
    accountQueryOptions($api.goals.index.queryOptions(), $authScope, $authToken)
  )
  const goals = computed(() =>
    $authLifecycle.isIdentityValidated.value ? goalsQuery.data.value?.data : undefined
  )

  const createGoalMutation = useMutation(
    $api.goals.store.mutationOptions({
      onMutate: () => ({ accountScope: $authScope.value }),
      onSuccess: ({ data }, _variables, context) => {
        if (!$authLifecycle.isCurrentScope(accountMutationScope(context))) return
        $queryClient.setQueryData(
          goalsQueryKey.value,
          (old) => old && { ...old, data: [...old.data.filter((i) => i.id !== data.id), data] }
        )
      },
    })
  )

  const updateGoalMutation = useMutation(
    $api.goals.update.mutationOptions({
      onMutate: () => ({ accountScope: $authScope.value }),
      onSuccess: ({ data }, _variables, context) => {
        if (!$authLifecycle.isCurrentScope(accountMutationScope(context))) return
        $queryClient.setQueryData(
          goalsQueryKey.value,
          (old) => old && { ...old, data: [...old.data.filter((i) => i.id !== data.id), data] }
        )
      },
    })
  )

  const destroyGoalMutation = useMutation(
    $api.goals.destroy.mutationOptions({
      onMutate: () => ({ accountScope: $authScope.value }),
      onSuccess: (_, { params: { id } }, context) => {
        if (!$authLifecycle.isCurrentScope(accountMutationScope(context))) return
        $queryClient.setQueryData(
          goalsQueryKey.value,
          (old) => old && { ...old, data: old.data.filter((i) => i.id !== id) }
        )
      },
    })
  )

  return { goalsQuery, goals, createGoalMutation, updateGoalMutation, destroyGoalMutation }
}
