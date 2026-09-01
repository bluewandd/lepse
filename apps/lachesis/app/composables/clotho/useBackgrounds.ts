import { useMutation, useQuery } from '@tanstack/vue-query'
import { accountMutationScope, accountQueryKey } from '~/lib/auth-cache'

export const useBackgrounds = () => {
  const { $api, $queryClient, $authScope, $authLifecycle } = useNuxtApp()

  const backgroundsQuery = useQuery($api.backgrounds.index.queryOptions())
  const backgrounds = computed(() => backgroundsQuery.data.value?.data)
  const profileQueryKey = accountQueryKey($api.account.profile.show.queryKey(), $authScope)

  const backgroundSelectMutation = useMutation(
    $api.backgrounds.select.mutationOptions({
      onMutate: () => ({ accountScope: $authScope.value }),
      onSuccess: ({ data }, _variables, context) => {
        if (!$authLifecycle.isCurrentScope(accountMutationScope(context))) return
        $queryClient.setQueryData(profileQueryKey.value, { data: data.user })
      },
    })
  )

  return { backgroundsQuery, backgrounds, backgroundSelectMutation }
}
