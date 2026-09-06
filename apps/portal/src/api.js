const TOKEN_KEY = 'world-atelier:session'
export function readSession() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null') } catch { return null }
}
export function writeSession(session) {
  if (session) localStorage.setItem(TOKEN_KEY, JSON.stringify(session))
  else localStorage.removeItem(TOKEN_KEY)
}
const pendingOperations = new Map()
export async function api(path, options = {}) {
  const session = readSession()
  const method = options.method || 'GET'
  const mutation = method !== 'GET'
  const body = options.body === undefined ? undefined : JSON.stringify(options.body)
  const operation = `${session?.user?.id}:${method}:${path}:${body || ''}`
  const operationKey = mutation ? options.idempotencyKey || pendingOperations.get(operation) || crypto.randomUUID() : null
  if (mutation) pendingOperations.set(operation, operationKey)
  let response
  // Retry a transport failure once with the same logical operation key.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch(`/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}), ...(operationKey ? { 'Idempotency-Key': operationKey } : {}) },
        ...(body === undefined ? {} : { body }),
        signal: options.signal || AbortSignal.timeout(120000),
      })
      break
    } catch (error) {
      if (attempt === 1 || options.signal?.aborted) {
        if (mutation) error.message = `${error.message}。结果可能已经提交；再次尝试相同操作会复用原操作标识。`
        throw error
      }
    }
  }
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch { data = { error: text || `HTTP ${response.status}` } }
  if (mutation && (response.ok || response.status < 500)) pendingOperations.delete(operation)
  if (!response.ok) {
    const error = new Error(typeof data.error === 'string' ? data.error : `请求失败 (${response.status})`)
    error.status = response.status
    error.details = data.details ?? data.conflicts ?? data
    throw error
  }
  return data
}
export async function verifyWebArtifacts(artifacts, onProgress) {
  const files = (Array.isArray(artifacts) ? artifacts : []).filter(a => a.platform === 'web')
  if (!files.length) throw new Error('发行清单没有网页游戏产物。')
  const total = files.reduce((sum,a) => sum + (Number(a.bytes) || 0), 0)
  let completed = 0
  for (const artifact of files) {
    if (!artifact.url || !/^[a-f0-9]{64}$/i.test(artifact.sha256 || '')) throw new Error('游戏产物缺少下载地址或 SHA-256 校验信息。')
    const url = new URL(artifact.url, location.href)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('产物下载地址不受支持。')
    const response = await fetch(url, {cache:'force-cache',signal:AbortSignal.timeout(180000)})
    if (!response.ok) throw new Error(`游戏下载失败：${artifact.path || artifact.url} (${response.status})`)
    const reader = response.body.getReader(), chunks = []
    let received = 0
    while (true) {
      const {done,value} = await reader.read()
      if (done) break
      chunks.push(value); received += value.length
      onProgress({loaded:completed+received,total,file:artifact.path,verifying:false})
    }
    if (Number.isFinite(artifact.bytes) && artifact.bytes !== received) throw new Error(`游戏产物长度不匹配：${artifact.path}`)
    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length }
    onProgress({loaded:completed+received,total,file:artifact.path,verifying:true})
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('')
    if (digest !== artifact.sha256.toLowerCase()) throw new Error(`游戏产物校验失败：${artifact.path}。已中止进入，原世界保持可用。`)
    completed += received
  }
  onProgress({loaded:completed,total:completed,complete:true})
}
export const post = (path, body = {}) => api(path, { method: 'POST', body })
export const clone = (value) => JSON.parse(JSON.stringify(value))
export const shortId = (value) => value ? String(typeof value === 'object' ? value.id || value.revision || '' : value).slice(0, 10) : '尚未生成'
export function downloadJSON(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = filename; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
