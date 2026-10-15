/** OIDC tokens and session secrets remain in server storage and HttpOnly cookies. */
export const MIKAKI_AUTH_MODE = import.meta.env.VITE_MIKAKI_AUTH_MODE === 'true'

export const loadMikakiSession = async (csrfOnly = false, signal?: AbortSignal) => {
  const response = await fetch(`/api/auth/mikaki/${csrfOnly ? 'csrf' : 'session'}`, {
    credentials: 'same-origin', cache: 'no-store', signal,
  })
  if (!response.ok) throw new Error('Mikaki sign-in is temporarily unavailable. Please try again.')
  const result: unknown = await response.json()
  if (!result || typeof result !== 'object' || !('csrf' in result) || typeof result.csrf !== 'string' ||
      !('signedIn' in result) || typeof result.signedIn !== 'boolean') {
    throw new Error('Could not check your sign-in session.')
  }
  return { csrf: result.csrf, signedIn: result.signedIn }
}

export const endMikakiSession = async () => {
  const { csrf } = await loadMikakiSession(true)
  const response = await fetch('/api/auth/mikaki/logout', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }),
  })
  if (!response.ok) throw new Error('Could not sign out. Please try again.')
}
