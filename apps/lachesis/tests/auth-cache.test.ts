import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computed, ref } from 'vue'
import { createTuyau } from '@tuyau/core/client'
import { createTuyauVueQueryClient } from '@tuyau/vue-query'
import { dehydrate, hydrate, QueryClient, QueryObserver } from '@tanstack/vue-query'
import { registry } from '@lepse/clotho/registry'
import {
  accountCacheScope,
  authCacheEventStorageKey,
  accountQueryKey,
  accountQueryOptions,
  createAccountAwarePersister,
  createAuthCacheLifecycle,
  filterPersistedClient,
  getAccountQueryScope,
  isAccountQueryKey,
  isSessionRequest,
} from '../app/lib/auth-cache.ts'

const baseKeys = {
  profile: [['account', 'profile', 'show'], { type: 'query' }],
  tasks: [['tasks', 'index'], { type: 'query' }],
  goals: [['goals', 'index'], { type: 'query' }],
  session: [
    ['day', 'session', 'show'],
    { request: { params: { date: '2026-09-01' } }, type: 'query' },
  ],
} as const

function createClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

class MemoryStorage {
  value: string | null = null

  async getItem() {
    return this.value
  }

  async setItem(_key: string, value: string) {
    this.value = value
  }

  async removeItem() {
    this.value = null
  }
}

test('account A logout clears every mounted account observer before account B can render', () => {
  const queryClient = createClient()
  const token = ref<string | null>('token-a')
  const lifecycle = createAuthCacheLifecycle({ token, queryClient })
  const scopeA = accountCacheScope(token.value)
  const scope = computed(() => accountCacheScope(token.value))
  const accountKeys = Object.values(baseKeys).map((key) => accountQueryKey(key, scopeA))
  const publicKey = [['backgrounds', 'index'], { type: 'query' }] as const

  for (const [index, key] of accountKeys.entries()) {
    queryClient.setQueryData(key, { owner: 'account-a', index })
  }
  queryClient.setQueryData(publicKey, { public: true })

  const observers = accountKeys.slice(0, 2).map((key) => {
    const observer = new QueryObserver(queryClient, {
      queryKey: key.value,
      queryFn: async () => ({ owner: 'network' }),
      enabled: false,
    })
    observer.subscribe(() => {})
    return observer
  })

  try {
    // The observers still point at the same active cache entries and therefore see A before the
    // transition.
    assert.equal(observers[0].getCurrentResult().data?.owner, 'account-a')
    assert.equal(observers[1].getCurrentResult().data?.owner, 'account-a')

    lifecycle.setToken(null)

    for (const key of accountKeys) {
      assert.equal(queryClient.getQueryData(key), undefined)
    }
    for (const observer of observers) {
      assert.equal(observer.getCurrentResult().data, undefined)
    }
    assert.deepEqual(queryClient.getQueryData(publicKey), { public: true })

    lifecycle.setToken('token-b')
    const accountBKey = accountQueryKey(baseKeys.tasks, scope)
    assert.equal(queryClient.getQueryData(accountBKey), undefined)
    queryClient.setQueryData(accountBKey, { owner: 'account-b' })
    assert.deepEqual(queryClient.getQueryData(accountBKey), { owner: 'account-b' })
    assert.equal(queryClient.getQueryData(accountQueryKey(baseKeys.tasks, scopeA)), undefined)
  } finally {
    for (const observer of observers) observer.destroy()
    lifecycle.dispose()
    queryClient.clear()
  }
})

test('persisted hydration retains public data but never hydrates another account or legacy account keys', async () => {
  const storage = new MemoryStorage()
  const tokenA = 'token-a'
  const scopeA = accountCacheScope(tokenA)
  const scopeB = accountCacheScope('token-b')
  const clientA = createClient()
  const keyA = accountQueryKey(baseKeys.profile, scopeA)
  const publicKey = [['backgrounds', 'index'], { type: 'query' }] as const
  clientA.setQueryData(keyA, { owner: 'account-a' })
  clientA.setQueryData(publicKey, { public: true })

  const persisterA = createAccountAwarePersister({
    storage,
    getScope: () => scopeA,
  })
  await persisterA.persistClient({
    timestamp: Date.now(),
    buster: '',
    clientState: dehydrate(clientA),
  })
  assert.ok(storage.value)
  assert.equal(storage.value.includes(tokenA), false)

  const clientB = createClient()
  const persisterB = createAccountAwarePersister({
    storage,
    getScope: () => scopeB,
  })
  const restoredForB = await persisterB.restoreClient()
  hydrate(clientB, restoredForB!.clientState)

  assert.equal(clientB.getQueryData(accountQueryKey(baseKeys.profile, scopeA)), undefined)
  assert.deepEqual(clientB.getQueryData(publicKey), { public: true })

  const clientReload = createClient()
  const restoredForA = await persisterA.restoreClient()
  hydrate(clientReload, restoredForA!.clientState)
  const lifecycleReload = createAuthCacheLifecycle({
    token: ref<string | null>(tokenA),
    queryClient: clientReload,
  })
  assert.deepEqual(clientReload.getQueryData(keyA), { owner: 'account-a' })
  assert.equal(lifecycleReload.isIdentityValidated.value, false)
  lifecycleReload.dispose()
  clientReload.clear()

  const legacyClient = createClient()
  legacyClient.setQueryData(baseKeys.profile, { owner: 'unscoped-account-a' })
  const legacyState = dehydrate(legacyClient)
  const storedState = JSON.parse(storage.value!)
  const filteredState = filterPersistedClient(
    {
      ...storedState,
      clientState: {
        ...storedState.clientState,
        queries: [...storedState.clientState.queries, ...legacyState.queries],
      },
    },
    scopeA
  )
  const clientAfterLegacy = createClient()
  hydrate(clientAfterLegacy, filteredState.clientState)
  // Legacy entries are removed by the restore filter while scoped A data remains available to A.
  assert.equal(clientAfterLegacy.getQueryData(baseKeys.profile), undefined)
  assert.deepEqual(clientAfterLegacy.getQueryData(keyA), { owner: 'account-a' })

  clientA.clear()
  clientB.clear()
  clientAfterLegacy.clear()
})

test('logout rewrites persisted storage without account data while preserving public data', async () => {
  const storage = new MemoryStorage()
  const queryClient = createClient()
  const token = ref<string | null>('token-a')
  const scope = computed(() => accountCacheScope(token.value))
  const persister = createAccountAwarePersister({
    storage,
    getScope: () => scope.value,
  })
  const lifecycle = createAuthCacheLifecycle({ token, queryClient, persister })
  const accountKey = accountQueryKey(baseKeys.tasks, scope)
  const publicKey = [['backgrounds', 'index'], { type: 'query' }] as const
  queryClient.setQueryData(accountKey, { owner: 'account-a' })
  queryClient.setQueryData(publicKey, { public: true })
  await persister.persistClient({
    timestamp: Date.now(),
    buster: '',
    clientState: dehydrate(queryClient),
  })

  lifecycle.clearAccountState()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const restored = await persister.restoreClient()
  const restoredClient = createClient()
  hydrate(restoredClient, restored!.clientState)

  try {
    assert.equal(restoredClient.getQueryData(accountKey), undefined)
    assert.deepEqual(restoredClient.getQueryData(publicKey), { public: true })
  } finally {
    lifecycle.dispose()
    queryClient.clear()
    restoredClient.clear()
  }
})

test('direct token loss clears profile, task, goal, and session data and mounted siblings', () => {
  const queryClient = createClient()
  const token = ref<string | null>('token-a')
  const lifecycle = createAuthCacheLifecycle({ token, queryClient })
  const scope = computed(() => accountCacheScope(token.value))
  const taskKey = accountQueryKey(baseKeys.tasks, scope)
  const taskObserver = new QueryObserver(queryClient, {
    queryKey: taskKey.value,
    queryFn: async () => ({ owner: 'network' }),
    enabled: false,
  })
  const siblingObserver = new QueryObserver(queryClient, {
    queryKey: taskKey.value,
    queryFn: async () => ({ owner: 'network' }),
    enabled: false,
  })
  const unsubscribeTask = taskObserver.subscribe(() => {})
  const unsubscribeSibling = siblingObserver.subscribe(() => {})
  queryClient.setQueryData(taskKey, { owner: 'account-a' })
  queryClient.setQueryData(accountQueryKey(baseKeys.profile, scope), { owner: 'account-a' })
  queryClient.setQueryData(accountQueryKey(baseKeys.goals, scope), { owner: 'account-a' })
  queryClient.setQueryData(accountQueryKey(baseKeys.session, scope), { owner: 'account-a' })

  try {
    token.value = null
    assert.equal(taskObserver.getCurrentResult().data, undefined)
    assert.equal(siblingObserver.getCurrentResult().data, undefined)
    assert.equal(
      queryClient
        .getQueryCache()
        .findAll({ predicate: (query) => isAccountQueryKey(query.queryKey) }).length,
      0
    )
  } finally {
    unsubscribeTask()
    unsubscribeSibling()
    taskObserver.destroy()
    siblingObserver.destroy()
    lifecycle.dispose()
    queryClient.clear()
  }
})

test('the bearer hook reads the new shared token on the first profile request after login', async () => {
  const queryClient = createClient()
  const token = ref<string | null>(null)
  const lifecycle = createAuthCacheLifecycle({ token, queryClient })
  const seenAuthorization: Array<string | null> = []
  const client = createTuyau({
    baseUrl: 'https://clotho.test',
    registry,
    fetch: async () =>
      new Response(JSON.stringify({ data: { emailVerified: true } }), {
        headers: { 'content-type': 'application/json' },
      }),
    hooks: {
      beforeRequest: [
        (request) => {
          if (token.value) request.headers.set('Authorization', `Bearer ${token.value}`)
          seenAuthorization.push(request.headers.get('authorization'))
        },
      ],
    },
  })
  const api = createTuyauVueQueryClient({ client })
  const scope = computed(() => accountCacheScope(token.value))

  try {
    lifecycle.setToken('token-b')
    await queryClient.fetchQuery(
      accountQueryOptions(api.account.profile.show.queryOptions(), scope, token)
    )
    assert.deepEqual(seenAuthorization, ['Bearer token-b'])

    lifecycle.handleUnauthorized('Bearer token-a')
    assert.equal(token.value, 'token-b')
    lifecycle.handleUnauthorized('Bearer token-b')
    assert.equal(token.value, null)
  } finally {
    lifecycle.dispose()
    queryClient.clear()
  }
})

test('only bearer-bearing protected requests can revoke the shared session', () => {
  const bearer = { Authorization: 'Bearer token-a' }
  assert.equal(
    isSessionRequest(
      new Request('https://clotho.test/api/v1/account/profile', { headers: bearer })
    ),
    true
  )
  assert.equal(
    isSessionRequest(new Request('https://clotho.test/api/v1/auth/login', { headers: bearer })),
    false
  )
  assert.equal(
    isSessionRequest(new Request('https://clotho.test/api/v1/auth/signup', { headers: bearer })),
    false
  )
  assert.equal(
    isSessionRequest(
      new Request('https://clotho.test/api/v1/verify/password-reset/request', {
        headers: bearer,
      })
    ),
    false
  )
  assert.equal(isSessionRequest(new Request('https://clotho.test/api/v1/backgrounds')), false)
})

test('cross-context login and logout clear the shared source and mounted account cache', () => {
  const previousWindow = (globalThis as Record<string, unknown>).window
  const previousBroadcastChannel = (globalThis as Record<string, unknown>).BroadcastChannel
  const listeners = new Map<string, (event: unknown) => void>()
  const fakeStorage = {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  }
  const fakeWindow = {
    localStorage: fakeStorage,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener)
    },
    removeEventListener: () => {},
  }
  ;(globalThis as Record<string, unknown>).window = fakeWindow
  ;(globalThis as Record<string, unknown>).BroadcastChannel = undefined

  const queryClient = createClient()
  const token = ref<string | null>('token-a')
  const lifecycle = createAuthCacheLifecycle({
    token,
    queryClient,
    refreshToken: () => {
      token.value = 'token-b'
    },
  })
  const scope = computed(() => accountCacheScope(token.value))
  const taskKey = accountQueryKey(baseKeys.tasks, scope)
  queryClient.setQueryData(taskKey, { owner: 'account-a' })

  try {
    listeners.get('storage')?.({
      key: authCacheEventStorageKey,
      newValue: JSON.stringify({
        id: 'external-login',
        type: 'token-set',
        scope: accountCacheScope('token-b'),
      }),
    })
    assert.equal(token.value, 'token-b')
    assert.equal(queryClient.getQueryData(taskKey), undefined)

    listeners.get('storage')?.({
      key: authCacheEventStorageKey,
      newValue: JSON.stringify({
        id: 'external-logout',
        type: 'token-cleared',
        scope: 'anonymous',
      }),
    })
    assert.equal(token.value, null)
    assert.equal(queryClient.getQueryData(taskKey), undefined)
  } finally {
    lifecycle.dispose()
    queryClient.clear()
    if (previousWindow === undefined) delete (globalThis as Record<string, unknown>).window
    else (globalThis as Record<string, unknown>).window = previousWindow
    if (previousBroadcastChannel === undefined) {
      delete (globalThis as Record<string, unknown>).BroadcastChannel
    } else {
      ;(globalThis as Record<string, unknown>).BroadcastChannel = previousBroadcastChannel
    }
  }
})

test('account keys cover the authenticated query families without scoping public backgrounds', () => {
  for (const key of Object.values(baseKeys)) {
    const scoped = accountQueryKey(key, 'token-a').value
    assert.equal(isAccountQueryKey(scoped), true)
    assert.equal(getAccountQueryScope(scoped), 'token-a')
  }

  assert.equal(isAccountQueryKey([['backgrounds', 'index'], { type: 'query' }]), false)
})
