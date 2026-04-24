import { describe, expect, it, vi } from 'vitest'

// Stub electron imports before requiring the module under test.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({ cookies: { on: () => {}, off: () => {}, get: async () => [] } }) },
}))
vi.mock('../sidecar', () => ({
  getSidecarInfo: () => ({ port: 1, pid: 1 }),
}))

import { mergeCookieArrays, hasRequiredCookies } from '../login-window'

describe('mergeCookieArrays', () => {
  it('unions and prefers the entry with later expirationDate', () => {
    const a = [{ name: 'x', value: 'a', expirationDate: 100 }]
    const b = [{ name: 'x', value: 'b', expirationDate: 200 }]
    expect(mergeCookieArrays(a, b)).toEqual({ x: 'b' })
  })
  it('keeps entries from one side when other is empty', () => {
    expect(mergeCookieArrays([{ name: 'x', value: '1' }], [])).toEqual({ x: '1' })
  })
  it('treats missing expirationDate as 0', () => {
    const a = [{ name: 'x', value: 'noexp' }]
    const b = [{ name: 'x', value: 'withexp', expirationDate: 1 }]
    expect(mergeCookieArrays(a, b)).toEqual({ x: 'withexp' })
  })
})

describe('hasRequiredCookies', () => {
  it('needs sessionid_ss, ttwid, passport_csrf_token', () => {
    expect(
      hasRequiredCookies({
        sessionid_ss: 'a',
        ttwid: 'b',
        passport_csrf_token: 'c',
      }),
    ).toBe(true)
    expect(hasRequiredCookies({ sessionid_ss: 'a', ttwid: 'b' })).toBe(false)
  })
  it('rejects empty-string values', () => {
    expect(
      hasRequiredCookies({
        sessionid_ss: '',
        ttwid: 'b',
        passport_csrf_token: 'c',
      }),
    ).toBe(false)
  })
})
