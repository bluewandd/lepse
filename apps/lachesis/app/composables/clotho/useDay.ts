import { useMutation, useQuery } from '@tanstack/vue-query'
import { accountMutationScope, accountQueryKey, accountQueryOptions } from '~/lib/auth-cache'

export const useDay = (date: string = getClientDate()) => {
  const { $api, $client, $queryClient, $authToken, $authScope, $authLifecycle } = useNuxtApp()

  // ─── Session ──────────────────────────────────────────────────────────────

  const focusSessionQueryKey = accountQueryKey(
    $api.day.session.show.queryKey({ params: { date } }),
    $authScope
  )
  const focusSessionQuery = useQuery(
    accountQueryOptions(
      $api.day.session.show.queryOptions({ params: { date } }),
      $authScope,
      $authToken
    )
  )
  const focusSession = computed(() =>
    $authLifecycle.isIdentityValidated.value ? focusSessionQuery.data.value?.data : undefined
  )

  const updateFocusSessionMutation = useMutation({
    mutationFn: ({
      body,
    }: {
      body: Parameters<typeof $client.api.day.session.update>[0]['body']
    }) => $client.api.day.session.update({ params: { date }, body }),
    onMutate: () => ({ accountScope: $authScope.value }),
    onSuccess: (data, _variables, context) => {
      if (!$authLifecycle.isCurrentScope(accountMutationScope(context))) return
      $queryClient.setQueryData(focusSessionQueryKey.value, data)
    },
  })

  const destroyFocusSessionMutation = useMutation({
    mutationFn: () => $client.api.day.session.destroy({ params: { date } }),
    onMutate: () => ({ accountScope: $authScope.value }),
    onSuccess: (_, _variables, context) => {
      if (!$authLifecycle.isCurrentScope(accountMutationScope(context))) return
      $queryClient.resetQueries({
        queryKey: focusSessionQueryKey.value,
      })
    },
  })

  const sessionReturns = {
    focusSessionQuery,
    focusSession,
    updateFocusSessionMutation,
    destroyFocusSessionMutation,
  }

  // ─── Returns ──────────────────────────────────────────────────────────────

  return { ...sessionReturns }
}
