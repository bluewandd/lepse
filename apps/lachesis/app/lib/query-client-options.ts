import { TuyauHTTPError } from '@tuyau/core/client'

export const appQueryCacheLifetime = 1000 * 60 * 60 * 24 * 7

export const appQueryDefaults = {
  queries: {
    retry: (failureCount: number, error: unknown) => {
      if (
        error instanceof TuyauHTTPError &&
        ([401, 404, 429].includes(error.status ?? 0) || /^5\d\d$/.test(String(error.status)))
      ) {
        return false
      }
      return failureCount < 3
    },
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    gcTime: appQueryCacheLifetime,
  },
}
