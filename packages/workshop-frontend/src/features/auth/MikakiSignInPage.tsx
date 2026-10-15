import { useEffect, useState } from 'react'
import { Button, Loader } from '@cloudflare/kumo'
import { loadMikakiSession } from './mikakiSession'
import { useDocumentTitle } from '../../useDocumentTitle'

export const MikakiSignInPage = () => {
  useDocumentTitle('Sign in with Mikaki')
  const [csrf, setCsrf] = useState<string | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    loadMikakiSession(true, controller.signal).then(result => setCsrf(result.csrf)).catch(() => {
      if (!controller.signal.aborted) setError(true)
    })
    return () => controller.abort()
  }, [])

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-5 bg-kumo-base px-6 py-12">
      <h1 className="text-2xl font-semibold text-kumo-default">Cloudflare OS</h1>
      <p className="max-w-sm text-center text-sm text-kumo-subtle">
        MikakiのPasskeyでログインして、会話やアプリ作成を始めましょう。
      </p>
      {error ? (
        <div role="alert" className="flex flex-col items-center gap-3">
          <p className="text-sm text-kumo-danger">ログインを開始できませんでした。もう一度お試しください。</p>
          <Button variant="secondary" onClick={() => window.location.reload()}>再読み込み</Button>
        </div>
      ) : csrf ? (
        <form action="/api/auth/mikaki/login" method="post" className="flex flex-col gap-3">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="return_to" value={window.location.pathname + window.location.search} />
          <Button type="submit" variant="primary">Mikakiでログイン</Button>
          <Button type="submit" variant="secondary" name="prompt" value="select_account">アカウントを選ぶ</Button>
        </form>
      ) : <Loader size="lg" />}
      <p className="max-w-sm text-center text-xs text-kumo-subtle">
        Vaultへ保存するときは、別途Vaultの解除と保存内容の確認を行います。
      </p>
    </main>
  )
}
