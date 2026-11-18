import type { ImageInput } from './types.mjs'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export async function antigravityImage(
  image: ImageInput,
  signal: AbortSignal,
): Promise<{ type: 'image'; data: string; mimeType: string }> {
  if (image.kind === 'base64') return { type: 'image', data: image.data, mimeType: image.mediaType }
  const url = new URL(image.data)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Antigravity image URL must use HTTP(S) without embedded credentials')
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    redirect: 'follow',
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Image download failed (${response.status})`)
  }
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (
    !IMAGE_TYPES.has(mimeType) ||
    Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES
  ) {
    await response.body?.cancel()
    throw new Error('Image must be PNG/JPEG/WebP/GIF and at most 20 MB')
  }
  const chunks: Uint8Array[] = []
  let size = 0
  if (!response.body) throw new Error('Image response has no body')
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > MAX_IMAGE_BYTES) throw new Error('Image exceeds 20 MB')
    chunks.push(chunk)
  }
  if (!size) throw new Error('Image response is empty')
  return { type: 'image', data: Buffer.concat(chunks).toString('base64'), mimeType }
}
