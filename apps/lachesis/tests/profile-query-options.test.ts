import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computed, effectScope, nextTick, ref } from 'vue'
import { createTuyau } from '@tuyau/core/client'
import { createTuyauVueQueryClient } from '@tuyau/vue-query'
import {
  dehydrate,
  focusManager,
  hydrate,
  QueryClient,
  QueryObserver,
  useQuery,
} from '@tanstack/vue-query'
import { registry } from '@lepse/clotho/registry'
import { accountCacheScope, accountQueryKey, accountQueryOptions } from '../app/lib/auth-cache.ts'
import { appQueryDefaults } from '../app/lib/query-client-options.ts'
import {
  profileQueryLifecycleOptions,
  profileQueryOptions,
} from '../app/lib/profile-query-options.ts'

type Profile = {
  emailVerified: boolean
}

type ProfileResponse = {
  data: Profile
}

type ProfileServer = {
  profile: Profile
  requests: number
}

const tuyauClient = createTuyau({
  baseUrl: 'https://clotho.test',
  registry,
})
const api = createTuyauVueQueryClient({ client: tuyauClient })
const profileEndpoint = api.account.profile.show
const profileQueryKey = profileEndpoint.queryKey()

function createAppQueryClient() {
  return new QueryClient({ defaultOptions: appQueryDefaults })
}

function createProfileApi(server: ProfileServer) {
  const client = createTuyau({
    baseUrl: 'https://clotho.test',
    registry,
    fetch: async () => {
      server.requests += 1
      return new Response(JSON.stringify({ data: server.profile }), {
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  return createTuyauVueQueryClient({ client })
}

function waitForProfile(
  observer: QueryObserver<Profile, Error>,
  emailVerified: boolean
): Promise<Profile> {
  return new Promise((resolve, reject) => {
    let settled = false
    let unsubscribe = () => {}
    const timeout = setTimeout(() => {
      settled = true
      unsubscribe()
      reject(new Error(`Profile did not become ${emailVerified ? 'verified' : 'unverified'}`))
    }, 1000)

    const finish = (profile: Profile) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      unsubscribe()
      resolve(profile)
    }

    unsubscribe = observer.subscribe((result) => {
      if (result.isSuccess && result.data?.emailVerified === emailVerified) {
        finish(result.data)
      }
    })

    // QueryObserver can synchronously notify before subscribe returns.
    if (settled) unsubscribe()
  })
}

function waitForValue<T>(
  readValue: () => T | undefined,
  predicate: (value: T) => boolean,
  message: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    const timeout = setTimeout(() => {
      settled = true
      if (pollTimer) clearTimeout(pollTimer)
      reject(new Error(message))
    }, 1000)

    const check = () => {
      if (settled) return

      const value = readValue()
      if (value !== undefined && predicate(value)) {
        settled = true
        clearTimeout(timeout)
        resolve(value)
        return
      }

      pollTimer = setTimeout(check, 0)
    }

    check()
  })
}

function waitForQueryTurn() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

test('focus refetch replaces an open app profile with the verified server state', async () => {
  const queryClient = createAppQueryClient()
  queryClient.mount()
  let serverProfile: Profile = { emailVerified: false }
  let fetches = 0
  const observer = new QueryObserver<Profile, Error>(queryClient, {
    queryKey: profileQueryKey,
    queryFn: async () => {
      fetches += 1
      return serverProfile
    },
    ...profileQueryLifecycleOptions,
  })
  const keepObserverMounted = observer.subscribe(() => {})

  try {
    await waitForProfile(observer, false)

    serverProfile = { emailVerified: true }
    const verified = waitForProfile(observer, true)
    focusManager.setFocused(false)
    focusManager.setFocused(true)

    assert.equal((await verified).emailVerified, true)
    assert.equal(fetches, 2)
  } finally {
    keepObserverMounted()
    observer.destroy()
    queryClient.unmount()
    queryClient.clear()
    focusManager.setFocused(undefined)
  }
})

test('mount refetch replaces a persisted stale profile after a full reload', async () => {
  const persistedClient = createAppQueryClient()
  persistedClient.setQueryData<Profile>(profileQueryKey, { emailVerified: false })
  const persistedState = dehydrate(persistedClient)
  persistedClient.clear()

  const queryClient = createAppQueryClient()
  hydrate(queryClient, persistedState)
  let fetches = 0
  const observer = new QueryObserver<Profile, Error>(queryClient, {
    queryKey: profileQueryKey,
    queryFn: async () => {
      fetches += 1
      return { emailVerified: true }
    },
    ...profileQueryLifecycleOptions,
  })
  const keepObserverMounted = observer.subscribe(() => {})

  try {
    assert.equal((await waitForProfile(observer, true)).emailVerified, true)
    assert.equal(fetches, 1)
  } finally {
    keepObserverMounted()
    observer.destroy()
    queryClient.unmount()
    queryClient.clear()
  }
})

test('application defaults do not refetch a stale profile on focus without lifecycle options', async () => {
  const queryClient = createAppQueryClient()
  queryClient.mount()
  let serverProfile: Profile = { emailVerified: false }
  let fetches = 0
  const observer = new QueryObserver<Profile, Error>(queryClient, {
    queryKey: profileQueryKey,
    queryFn: async () => {
      fetches += 1
      return serverProfile
    },
  })
  const keepObserverMounted = observer.subscribe(() => {})

  try {
    await waitForProfile(observer, false)

    serverProfile = { emailVerified: true }
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await waitForQueryTurn()

    assert.equal(fetches, 1)
    assert.equal(observer.getCurrentResult().data?.emailVerified, false)
  } finally {
    keepObserverMounted()
    observer.destroy()
    queryClient.unmount()
    queryClient.clear()
    focusManager.setFocused(undefined)
  }
})

test('profile query options use the scoped application key shared by mutation writers', () => {
  const token = ref<string | null>(null)
  const scope = ref(accountCacheScope('account-a'))
  const profileOptions = accountQueryOptions(
    profileEndpoint.queryOptions(undefined, profileQueryOptions(token)),
    scope,
    token
  )
  const scopedProfileKey = accountQueryKey(profileEndpoint.queryKey(), scope)

  assert.deepEqual(profileOptions.queryKey.value, scopedProfileKey.value)
  assert.equal(profileOptions.enabled?.value, false)
  assert.notDeepEqual(profileEndpoint.queryOptions({}).queryKey, profileEndpoint.queryKey())

  const queryClient = createAppQueryClient()
  const profile = { emailVerified: false }
  queryClient.setQueryData<ProfileResponse>(scopedProfileKey, { data: profile })

  assert.deepEqual(queryClient.getQueryData<ProfileResponse>(profileOptions.queryKey), {
    data: profile,
  })
  queryClient.clear()
})

test('auth startup skips profile prefetch without a token', async () => {
  const globalObject = globalThis as Record<string, unknown>
  const previousDefineNuxtPlugin = globalObject.defineNuxtPlugin
  const token = ref<string | null>(null)
  const scope = computed(() => accountCacheScope(token.value))
  const queryOptionsCalls: unknown[][] = []
  let prefetches = 0

  globalObject.defineNuxtPlugin = (plugin) => plugin

  try {
    const { default: authPlugin } =
      await import('../app/plugins/auth.ts?profile-query-options-test')
    const setup = (authPlugin as { setup: (app: unknown) => Promise<void> }).setup
    const app = {
      $api: {
        account: {
          profile: {
            show: {
              queryOptions: (...args: unknown[]) => {
                queryOptionsCalls.push(args)
                return { queryKey: [] }
              },
            },
          },
        },
      },
      $queryClient: {
        prefetchQuery: async () => {
          prefetches += 1
        },
      },
      $authToken: token,
      $authScope: scope,
      $authLifecycle: { markIdentityValidated: () => {} },
      $queryPersistenceReady: Promise.resolve(),
    }

    await setup(app)
    assert.equal(prefetches, 0)

    token.value = 'test-token'
    await setup(app)
    assert.equal(prefetches, 1)
    assert.equal(queryOptionsCalls[0]?.[0], undefined)
    assert.equal((queryOptionsCalls[0]?.[1] as { retry?: boolean }).retry, false)
    assert.equal(typeof (queryOptionsCalls[0]?.[1] as { enabled?: unknown }).enabled, 'object')
  } finally {
    if (previousDefineNuxtPlugin === undefined) delete globalObject.defineNuxtPlugin
    else globalObject.defineNuxtPlugin = previousDefineNuxtPlugin
  }
})

test('an anonymous profile observer does not refetch on focus and reacts immediately after login', async () => {
  const queryClient = createAppQueryClient()
  queryClient.mount()
  const token = ref<string | null>(null)
  const siblingToken = ref<string | null>(null)
  const server: ProfileServer = {
    profile: { emailVerified: true },
    requests: 0,
  }
  const api = createProfileApi(server)
  const endpoint = api.account.profile.show
  queryClient.setQueryData<ProfileResponse>(endpoint.queryKey(), {
    data: { emailVerified: false },
  })
  const cachedQuery = queryClient.getQueryCache().find({ queryKey: endpoint.queryKey() })

  const scope = effectScope()
  let userQuery: ReturnType<typeof useQuery> | undefined
  let siblingQuery: ReturnType<typeof useQuery> | undefined
  scope.run(() => {
    userQuery = useQuery(
      api.account.profile.show.queryOptions(undefined, profileQueryOptions(token)),
      queryClient
    )
    siblingQuery = useQuery(
      api.account.profile.show.queryOptions(undefined, profileQueryOptions(siblingToken)),
      queryClient
    )
  })
  const query = userQuery!
  const sibling = siblingQuery!

  try {
    const cachedProfile = query.data.value as ProfileResponse | undefined
    assert.equal(cachedProfile?.data.emailVerified, false)

    for (let i = 0; i < 2; i += 1) {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    }
    await waitForQueryTurn()
    assert.equal(server.requests, 0)

    token.value = 'test-token'
    siblingToken.value = 'test-token'
    await nextTick()
    const freshProfile = await waitForValue(
      () => (query.data.value as ProfileResponse | undefined)?.data,
      (profile) => profile.emailVerified,
      'Profile did not become verified after login'
    )
    assert.equal(freshProfile.emailVerified, true)
    assert.equal(server.requests, 1)

    token.value = null
    queryClient.removeQueries({ queryKey: endpoint.queryKey() })
    assert.equal(queryClient.getQueryData(endpoint.queryKey()), undefined)
    assert.equal(server.requests, 1)

    siblingToken.value = null
    await nextTick()
    assert.equal(query.data.value, undefined)
    assert.equal(sibling.data.value, undefined)

    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await waitForQueryTurn()
    assert.equal(server.requests, 1)
  } finally {
    scope.stop()
    cachedQuery?.destroy()
    queryClient.unmount()
    queryClient.clear()
    focusManager.setFocused(undefined)
  }
})
