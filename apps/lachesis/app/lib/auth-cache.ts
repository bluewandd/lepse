import { computed, ref, toValue, watch, type ComputedRef, type MaybeRef, type Ref } from 'vue'
import { type DehydratedState, type QueryClient, type QueryKey } from '@tanstack/vue-query'
import { persistQueryClientSave } from '@tanstack/query-persist-client-core'
import type { Persister, PersistedClient } from '@tanstack/query-persist-client-core'

export const authTokenCookieName = 'auth_token'
export const accountQueryScopeField = '__lepse_account_scope__'
export const anonymousAccountScope = 'anonymous'
export const accountQueryPersistenceKey = 'REACT_QUERY_OFFLINE_CACHE'
export const authCacheEventStorageKey = 'lepse:auth-cache:event'

const accountQueryRoots = new Set([
  'account',
  'day',
  'focus_sessions',
  'goals',
  'habits',
  'journals',
  'scribbles',
  'task_days',
  'tasks',
])

const accountMutationRoots = new Set([
  ...accountQueryRoots,
  'auth',
  'backgrounds',
  'reset',
  'verify',
])

type AuthTokenRef = Pick<Ref<string | null | undefined>, 'value'>
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type AccountCacheScope = string

export interface AccountAwarePersister extends Persister {
  /** Invalidate writes queued before an account transition. */
  invalidatePendingWrites: () => void
}

export interface AuthCacheLifecycle {
  readonly token: AuthTokenRef
  readonly scope: ComputedRef<AccountCacheScope>
  readonly isIdentityValidated: ComputedRef<boolean>
  setToken: (value: string | null | undefined) => void
  markIdentityValidated: (scope?: AccountCacheScope) => void
  isCurrentScope: (scope?: AccountCacheScope) => boolean
  isCurrentTokenScope: (scope?: AccountCacheScope) => boolean
  handleUnauthorized: (authorization?: string | null) => void
  clearAccountState: () => void
  dispose: () => void
}

export interface AuthCacheLifecycleOptions {
  token: AuthTokenRef
  queryClient: QueryClient
  persister?: AccountAwarePersister
  refreshToken?: () => void
}

export interface AuthCacheEvent {
  id: string
  type: 'token-cleared' | 'token-set'
  scope: AccountCacheScope
}

export function accountCacheScope(token: string | null | undefined): AccountCacheScope {
  if (!token) return anonymousAccountScope

  // The bearer is deliberately not put in a query key or persisted value. This is only a
  // namespace fingerprint; profile data remains untrusted until the current bearer succeeds.
  let firstHash = 2166136261
  let secondHash = 2246822507
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index)
    firstHash = Math.imul(firstHash ^ code, 16777619)
    secondHash = Math.imul(secondHash ^ code, 3266489909)
  }

  return `token-${(firstHash >>> 0).toString(16)}-${(secondHash >>> 0).toString(16)}`
}

export function accountQueryKey<T extends QueryKey>(
  baseKey: T,
  scope: MaybeRef<AccountCacheScope>
): ComputedRef<T> {
  // Keep Tuyau's data-tag type while adding the runtime namespace segment.
  return computed(() => [
    ...baseKey,
    { [accountQueryScopeField]: toValue(scope) },
  ]) as unknown as ComputedRef<T>
}

/** Add an account namespace and a token-presence guard to a generated Tuyau query. */
export function accountQueryOptions<Options extends { queryKey: QueryKey }>(
  options: Options,
  scope: MaybeRef<AccountCacheScope>,
  token: AuthTokenRef
): Options {
  return {
    ...options,
    queryKey: accountQueryKey(options.queryKey, scope),
    enabled: computed(() => Boolean(token.value)),
  } as Options
}

export function accountMutationScope(context: unknown): AccountCacheScope | undefined {
  if (!context || typeof context !== 'object') return undefined
  const scope = (context as { accountScope?: unknown }).accountScope
  return typeof scope === 'string' ? scope : undefined
}

function keySegments(key: QueryKey): ReadonlyArray<unknown> {
  return Array.isArray(key[0]) ? key[0] : key
}

function hasAccountScopeMarker(key: QueryKey): boolean {
  const last = key[key.length - 1]
  return (
    typeof last === 'object' &&
    last !== null &&
    !Array.isArray(last) &&
    accountQueryScopeField in last
  )
}

export function getAccountQueryScope(key: QueryKey): AccountCacheScope | undefined {
  const last = key[key.length - 1]
  if (
    typeof last !== 'object' ||
    last === null ||
    Array.isArray(last) ||
    !(accountQueryScopeField in last)
  ) {
    return undefined
  }

  const scope = (last as Record<string, unknown>)[accountQueryScopeField]
  return typeof scope === 'string' ? scope : undefined
}

/** Recognize both current namespaced keys and legacy unscoped account keys. */
export function isAccountQueryKey(key: QueryKey): boolean {
  const segments = keySegments(key)
  return (
    hasAccountScopeMarker(key) ||
    (typeof segments[0] === 'string' && accountQueryRoots.has(segments[0]))
  )
}

export function isAccountMutationKey(key: QueryKey | undefined): boolean {
  if (!key) return false
  const segments = keySegments(key)
  return typeof segments[0] === 'string' && accountMutationRoots.has(segments[0])
}

function isProfileQueryKey(key: QueryKey): boolean {
  const segments = keySegments(key)
  return segments[0] === 'account' && segments[1] === 'profile'
}

function filterDehydratedState(
  clientState: DehydratedState,
  scope: AccountCacheScope
): DehydratedState {
  return {
    ...clientState,
    // Unscoped account entries are intentionally discarded: their owner cannot be proven.
    queries: clientState.queries.filter(
      (query) =>
        !isAccountQueryKey(query.queryKey) ||
        (getAccountQueryScope(query.queryKey) === scope && scope !== anonymousAccountScope)
    ),
    // No mutation in Lachesis is currently safe to replay for another bearer (the day-session
    // mutations do not even carry a mutation key). Public mutations are not currently persisted.
    mutations: [],
  }
}

export function filterPersistedClient(
  persistedClient: PersistedClient,
  scope: AccountCacheScope
): PersistedClient {
  return {
    ...persistedClient,
    clientState: filterDehydratedState(persistedClient.clientState, scope),
  }
}

/**
 * Persist only public data and data belonging to the current bearer namespace. Writes are queued
 * serially so a logout cannot be followed by a delayed write containing the old account cache.
 */
export function createAccountAwarePersister(options: {
  storage: StorageLike | undefined | null
  getScope: () => AccountCacheScope
  key?: string
}): AccountAwarePersister {
  const { storage, getScope, key = accountQueryPersistenceKey } = options
  let writeGeneration = 0
  let pending = Promise.resolve()

  const enqueue = (generation: number, operation: () => Promise<void>) => {
    const next = pending.then(async () => {
      if (generation !== writeGeneration) return
      await operation()
    })
    pending = next.catch(() => {})
    return next
  }

  return {
    persistClient: (persistedClient) => {
      if (!storage) return Promise.resolve()

      const generation = writeGeneration
      const filtered = filterPersistedClient(persistedClient, getScope())
      return enqueue(generation, async () => {
        await storage.setItem(key, JSON.stringify(filtered))
      })
    },

    restoreClient: async () => {
      if (!storage) return undefined
      const serialized = await storage.getItem(key)
      if (!serialized) return undefined
      return filterPersistedClient(JSON.parse(serialized) as PersistedClient, getScope())
    },

    removeClient: () => {
      writeGeneration += 1
      if (!storage) return Promise.resolve()
      const generation = writeGeneration
      return enqueue(generation, async () => {
        await storage.removeItem(key)
      })
    },

    invalidatePendingWrites: () => {
      writeGeneration += 1
    },
  }
}

function authEventId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function isSessionRequest(request: Pick<Request, 'url' | 'headers'>): boolean {
  if (!request.headers.get('authorization')) return false

  try {
    const path = new URL(request.url).pathname
    return !['/auth/login', '/auth/signup', '/verify/password-reset/request'].some((publicPath) =>
      path.endsWith(publicPath)
    )
  } catch {
    // A bearer-bearing request with an unusual URL is safer to treat as authenticated than to
    // leave a revoked session active.
    return true
  }
}

function isAuthCacheEvent(value: unknown): value is AuthCacheEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<AuthCacheEvent>
  return (
    typeof event.id === 'string' &&
    (event.type === 'token-cleared' || event.type === 'token-set') &&
    typeof event.scope === 'string'
  )
}

/**
 * Owns the one shared bearer source, account cache teardown, identity validation, and browser
 * context notifications. No caller may read or write the auth cookie independently.
 */
export function createAuthCacheLifecycle({
  token,
  queryClient,
  persister,
  refreshToken,
}: AuthCacheLifecycleOptions): AuthCacheLifecycle {
  const scope = computed(() => accountCacheScope(token.value))
  const validatedScope = ref<AccountCacheScope | null>(null)
  let accountStateCleared = false
  let canValidateProfile = true
  let suppressBroadcast = false
  const seenEventIds = new Set<string>()

  const persistCurrentCache = () => {
    if (!persister) return
    void persistQueryClientSave({ queryClient, persister }).catch(() => {})
  }

  const clearAccountState = () => {
    validatedScope.value = null
    accountStateCleared = true
    canValidateProfile = false
    persister?.invalidatePendingWrites()

    const accountQueries = queryClient.getQueryCache().findAll({
      predicate: (query) => isAccountQueryKey(query.queryKey),
    })

    // Reset first so every mounted observer receives an empty result. Removing an active query
    // alone destroys its cache entry but can leave the observer displaying its last result.
    for (const query of accountQueries) query.reset()
    queryClient.removeQueries({ predicate: (query) => isAccountQueryKey(query.queryKey) })
    persistCurrentCache()
  }

  let channel: BroadcastChannel | undefined
  const broadcast = (type: AuthCacheEvent['type'], eventScope: AccountCacheScope) => {
    if (typeof window === 'undefined') return

    const event: AuthCacheEvent = { id: authEventId(), type, scope: eventScope }
    seenEventIds.add(event.id)

    try {
      channel?.postMessage(event)
    } catch {}

    try {
      window.localStorage.setItem(authCacheEventStorageKey, JSON.stringify(event))
      window.localStorage.removeItem(authCacheEventStorageKey)
    } catch {}
  }

  const applyExternalEvent = (event: AuthCacheEvent) => {
    if (seenEventIds.has(event.id)) return
    seenEventIds.add(event.id)

    if (event.type === 'token-cleared') {
      suppressBroadcast = true
      token.value = null
      suppressBroadcast = false
      // If the source was already empty, its watcher does not run; clear observers anyway.
      validatedScope.value = null
      clearAccountState()
      return
    }

    // Cookies remain the security boundary. Refreshing the one shared cookie source lets a
    // sibling tab publish a login without putting the bearer in localStorage or BroadcastChannel.
    // Nuxt's refreshCookie communicates asynchronously, so hide the old account immediately and
    // verify the refreshed namespace on the next task before deciding whether to clear the source.
    if (!token.value || accountCacheScope(token.value) !== event.scope) clearAccountState()
    suppressBroadcast = true
    try {
      refreshToken?.()
    } catch {}
    suppressBroadcast = false

    const verifyRefreshedToken = () => {
      if (token.value && accountCacheScope(token.value) === event.scope) return
      // The cookie may not be readable in this context (for example, a blocked WebView). Never
      // keep rendering the previous account in that case; a subsequent app load can retry.
      suppressBroadcast = true
      token.value = null
      suppressBroadcast = false
      validatedScope.value = null
      clearAccountState()
    }
    if (!token.value || accountCacheScope(token.value) !== event.scope) {
      setTimeout(verifyRefreshedToken, 0)
    }
  }

  let storageListener: ((event: StorageEvent) => void) | undefined

  if (typeof window !== 'undefined') {
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(authCacheEventStorageKey)
        channel.addEventListener('message', (message) => {
          if (isAuthCacheEvent(message.data)) applyExternalEvent(message.data)
        })
      }
    } catch {}

    storageListener = (event) => {
      if (event.key !== authCacheEventStorageKey || !event.newValue) return
      try {
        const parsed: unknown = JSON.parse(event.newValue)
        if (isAuthCacheEvent(parsed)) applyExternalEvent(parsed)
      } catch {}
    }
    window.addEventListener('storage', storageListener)
  }

  const stopTokenWatch = watch(
    () => token.value,
    (next, previous) => {
      if (next === previous) return

      validatedScope.value = null
      clearAccountState()
      canValidateProfile = Boolean(next)
      if (!suppressBroadcast) {
        broadcast(next ? 'token-set' : 'token-cleared', accountCacheScope(next))
      }
    },
    { flush: 'sync' }
  )

  const stopProfileValidation = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return
    if (!isProfileQueryKey(event.query.queryKey)) return

    const queryScope = getAccountQueryScope(event.query.queryKey)
    if (canValidateProfile && queryScope && token.value && queryScope === scope.value) {
      validatedScope.value = queryScope
      accountStateCleared = false
    }
  })

  return {
    token,
    scope,
    isIdentityValidated: computed(
      () =>
        Boolean(token.value) &&
        !accountStateCleared &&
        validatedScope.value !== null &&
        validatedScope.value === scope.value
    ),

    setToken: (value) => {
      token.value = value ?? null
    },

    markIdentityValidated: (validatedForScope = scope.value) => {
      if (token.value && validatedForScope === scope.value) {
        validatedScope.value = validatedForScope
        accountStateCleared = false
        canValidateProfile = true
      }
    },

    isCurrentScope: (currentScope) =>
      Boolean(token.value) && !accountStateCleared && currentScope === scope.value,

    isCurrentTokenScope: (currentScope) => Boolean(token.value) && currentScope === scope.value,

    handleUnauthorized: (authorization) => {
      if (authorization && authorization !== `Bearer ${token.value}`) return
      if (token.value) token.value = null
      else {
        validatedScope.value = null
        clearAccountState()
      }
    },

    clearAccountState,

    dispose: () => {
      stopTokenWatch()
      stopProfileValidation()
      channel?.close()
      channel = undefined
      if (storageListener && typeof window !== 'undefined') {
        window.removeEventListener('storage', storageListener)
      }
      storageListener = undefined
    },
  }
}
