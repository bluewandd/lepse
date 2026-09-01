import { registry } from '@lepse/clotho/registry'
import { createTuyau } from '@tuyau/core/client'
import { persistQueryClient } from '@tanstack/query-persist-client-core'
import { focusManager, QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { createTuyauVueQueryClient } from '@tuyau/vue-query'
import { toast } from 'vue-sonner'
import {
  accountCacheScope,
  authTokenCookieName,
  createAccountAwarePersister,
  createAuthCacheLifecycle,
  isSessionRequest,
} from '~/lib/auth-cache'
import { appQueryCacheLifetime, appQueryDefaults } from '~/lib/query-client-options'

export default defineNuxtPlugin({
  name: 'clotho',
  async setup(app) {
    const config = useRuntimeConfig()
    // This is the sole auth_token reader. Every API hook and composable consumes this ref through
    // the plugin-provided source instead of creating another cookie ref.
    const authToken = useCookie<string | null>(authTokenCookieName, {
      maxAge: 60 * 60 * 24 * 365 /* one year */,
    })
    const authScope = computed(() => accountCacheScope(authToken.value))

    // Refetch opt-in queries when this window becomes active as well as when its tab becomes
    // visible. The verification link is served by Clotho, so the app cannot use a same-origin
    // cache event to notify this window.
    focusManager.setEventListener((onFocus) => {
      if (typeof window === 'undefined') return

      const handleFocus = () => onFocus()
      window.addEventListener('visibilitychange', handleFocus)
      window.addEventListener('focus', handleFocus)

      return () => {
        window.removeEventListener('visibilitychange', handleFocus)
        window.removeEventListener('focus', handleFocus)
      }
    })

    let storage: Storage | undefined
    try {
      storage = typeof window === 'undefined' ? undefined : window.localStorage
    } catch {
      // Some WebViews expose localStorage but reject access. The in-memory client remains usable.
    }

    const queryClient = new QueryClient({ defaultOptions: appQueryDefaults })
    const persister = createAccountAwarePersister({
      storage,
      getScope: () => authScope.value,
    })
    const authLifecycle = createAuthCacheLifecycle({
      token: authToken,
      queryClient,
      persister,
      // A storage/BroadcastChannel event never carries the bearer. Refresh the one shared cookie
      // source instead, and let its synchronous watcher perform the cache transition.
      refreshToken: () => refreshCookie(authTokenCookieName),
    })

    let persistenceReady = Promise.resolve()
    app.vueApp.use(VueQueryPlugin, {
      queryClient,
      clientPersister: (client) => {
        const result = persistQueryClient({
          queryClient: client,
          maxAge: appQueryCacheLifetime,
          persister,
        })
        persistenceReady = result[1]
        return result
      },
    })

    // The tuyau client reads the same shared source at request time. A response for an old
    // bearer cannot revoke a newer session because the lifecycle compares the sent header.
    const client = createTuyau({
      baseUrl: config.public.apiUrl,
      registry,
      hooks: {
        beforeRequest: [
          (request) => {
            if (authToken.value) {
              request.headers.set('Authorization', `Bearer ${authToken.value}`)
            } else {
              request.headers.delete('Authorization')
            }
            request.headers.set('x-client-date', getClientDate())
          },
        ],
        afterResponse: [
          (request, _options, response) => {
            if (response.status === 401 && isSessionRequest(request)) {
              authLifecycle.handleUnauthorized(request.headers.get('authorization'))
            }
            if (response.status === 429) {
              toast.error('Alright, you gotta chill -_-', {
                description: 'You got rate limited. Retry again later.',
              })
            }
          },
        ],
      },
    })

    // the tuyau vue-query client
    const api = createTuyauVueQueryClient({
      client,
    })

    return {
      provide: {
        queryClient, // queries without context (in plugins for example)
        client, // for overriding and using client directly instead of type safe options
        api, // for type-safe query and mutation options
        authToken,
        authScope,
        authLifecycle,
        queryPersistenceReady: persistenceReady,
      },
    }
  },
})
