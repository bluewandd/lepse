import { computed, type ComputedRef } from 'vue'

export const profileQueryLifecycleOptions = {
  // The profile is the authority for authentication and email verification state.
  staleTime: 0,
  refetchOnMount: 'always',
  refetchOnWindowFocus: true,
} as const

type AuthToken = {
  value: string | null | undefined
}

type ProfileQueryOptions = typeof profileQueryLifecycleOptions & {
  enabled: ComputedRef<boolean>
}

export const profileQueryOptions = (token: AuthToken): ProfileQueryOptions => ({
  ...profileQueryLifecycleOptions,
  enabled: computed(() => Boolean(token.value)),
})
