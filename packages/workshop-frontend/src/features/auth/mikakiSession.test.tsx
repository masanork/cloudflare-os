// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MikakiSignInPage } from './MikakiSignInPage'
import { endMikakiSession } from './mikakiSession'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('starts login with a server-provided CSRF value and keeps the current app destination', async () => {
  history.replaceState({}, '', '/workspace/demo?chat=3')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ signedIn: false, csrf: 'browser-bound-csrf' })))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<MikakiSignInPage />))
    const form = container.querySelector('form')!
    expect(form.getAttribute('action')).toBe('/api/auth/mikaki/login')
    expect(new FormData(form).get('csrf')).toBe('browser-bound-csrf')
    expect(new FormData(form).get('return_to')).toBe('/workspace/demo?chat=3')
    expect(container.textContent).toContain('Mikakiでログイン')
  } finally { act(() => root.unmount()); container.remove(); history.replaceState({}, '', '/') }
})

it('ends the app session through an origin-protected POST without exposing any token', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ signedIn: true, csrf: 'csrf' }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetch)
  await endMikakiSession()
  expect(fetch.mock.calls[1][0]).toBe('/api/auth/mikaki/logout')
  expect(fetch.mock.calls[1][1]!.method).toBe('POST')
  expect(String(fetch.mock.calls[1][1]!.body)).toBe('csrf=csrf')
})

it('ignores old localStorage credentials in Mikaki mode and waits for cookie authentication', async () => {
  vi.stubEnv('VITE_MIKAKI_AUTH_MODE', 'true')
  vi.resetModules()
  const { useAuth } = await import('../../useAuth')
  localStorage.setItem('authToken', 'obsolete-password-token')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ signedIn: true, csrf: 'csrf' })))
  const authenticate = vi.fn<() => void>()
  const dispose = vi.fn<() => void>()
  const createAuth = () => ({ whoami: async () => ({ type: 'user', id: 'mikaki-id', name: 'Owner' }),
    [Symbol.dispose]: dispose })
  const authenticateFromMikaki = vi.fn<typeof createAuth>(createAuth)
  const publicApi = { authenticate, authenticateFromMikaki } as unknown as Parameters<typeof useAuth>[0]
  let authenticated = false
  const Consumer = () => {
    const state = useAuth(publicApi)
    authenticated = state.isAuthenticated
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Consumer />))
    expect(authenticated).toBe(true)
    expect(authenticate).not.toHaveBeenCalled()
    expect(authenticateFromMikaki).toHaveBeenCalledOnce()
  } finally { act(() => root.unmount()); localStorage.clear() }
  expect(dispose).toHaveBeenCalledOnce()
})
