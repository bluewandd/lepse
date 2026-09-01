import { accountQueryOptions } from '../lib/auth-cache.ts'
import { profileQueryOptions } from '../lib/profile-query-options.ts'

export default defineNuxtPlugin({
  name: 'auth',
  dependsOn: ['clotho'],
  async setup(app) {
    // Hydration must finish before the startup profile request can establish identity.
    await app.$queryPersistenceReady
    const token = app.$authToken
    if (!token.value) return

    const scope = app.$authScope.value
    try {
      await app.$queryClient.prefetchQuery(
        accountQueryOptions(
          app.$api.account.profile.show.queryOptions(undefined, {
            retry: false,
            ...profileQueryOptions(token),
          }),
          app.$authScope,
          token
        )
      )

      // A successful network profile response (rather than hydrated data) establishes identity.
      if (token.value && app.$authScope.value === scope) {
        app.$authLifecycle.markIdentityValidated(scope)
      }
    } catch {
      // Keep startup usable while offline or after a revoked token. The query still has the
      // explicit no-retry policy; without a successful response the cached profile is not trusted.
    }
  },
})
