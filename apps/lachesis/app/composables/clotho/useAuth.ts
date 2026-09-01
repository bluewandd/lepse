import { useMutation, useQuery } from '@tanstack/vue-query'
import { accountMutationScope, accountQueryKey, accountQueryOptions } from '~/lib/auth-cache'
import { profileQueryOptions } from '~/lib/profile-query-options'

export const useAuth = () => {
  const { $api, $queryClient, $authToken, $authScope, $authLifecycle } = useNuxtApp()

  const profileQueryKey = accountQueryKey($api.account.profile.show.queryKey(), $authScope)
  const userQuery = useQuery(
    accountQueryOptions(
      $api.account.profile.show.queryOptions(undefined, profileQueryOptions($authToken)),
      $authScope,
      $authToken
    )
  )
  const user = computed(() =>
    $authLifecycle.isIdentityValidated.value ? userQuery.data.value?.data : undefined
  )

  const loginMutation = useMutation(
    $api.auth.accessToken.store.mutationOptions({
      onSuccess: ({ data }) => {
        // Publish first. Any profile request triggered by the reactive query must read this token.
        $authLifecycle.setToken(data.token)
        $queryClient.setQueryData(profileQueryKey.value, { data: data.user })
        $authLifecycle.markIdentityValidated()
      },
    })
  )

  const signupMutation = useMutation(
    $api.auth.newAccount.store.mutationOptions({
      onSuccess: ({ data }) => {
        $authLifecycle.setToken(data.token)
        $queryClient.setQueryData(profileQueryKey.value, { data: data.user })
        $authLifecycle.markIdentityValidated()
      },
    })
  )

  const logoutMutation = useMutation(
    $api.auth.accessToken.destroy.mutationOptions({
      // Clear observers before the request settles, while the shared token remains available for
      // the logout bearer. The settled callback then removes the cookie even if the server is
      // offline or the token was already revoked.
      onMutate: () => {
        const accountScope = $authScope.value
        $authLifecycle.clearAccountState()
        return { accountScope }
      },
      onSettled: (_data, _error, _variables, context) => {
        if ($authLifecycle.isCurrentTokenScope(accountMutationScope(context))) {
          $authLifecycle.setToken(null)
        }
      },
    })
  )

  const requestEmailVerificationMutation = useMutation($api.verify.email.request.mutationOptions())
  const requestPasswordResetMutation = useMutation($api.reset.password.request.mutationOptions())

  const updateProfileMutation = useMutation(
    $api.account.profile.update.mutationOptions({
      onMutate: () => ({ accountScope: $authScope.value }),
      onSuccess: ({ data }, _variables, context) => {
        if (!$authLifecycle.isCurrentScope(accountMutationScope(context))) return
        $queryClient.setQueryData(profileQueryKey.value, { data: data.user })
      },
    })
  )

  return {
    userQuery,
    user,
    loginMutation,
    signupMutation,
    logoutMutation,
    requestEmailVerificationMutation,
    requestPasswordResetMutation,
    updateProfileMutation,
  }
}
