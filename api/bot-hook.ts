import type { VercelApiHandler } from '@vercel/node'

import profiler from '../shared/profiler'
import deta from './_utils/deta'
import telegram from './_utils/telegram'

const DRIVE_CHAT_ID = process.env.TG_CHAT_DRIVE

export default <VercelApiHandler>async function (req, res) {
  const { start, end, result } = profiler()

  const queryID = req.body.inline_query?.id
  const input = req.body.inline_query?.query
  const [text, color] = input.split(/\s+/)

  if (text) {
    let stickerFileID: string

    // Check if an identical sticker has been generated before
    start('check-cache')
    const cached = await deta.get<never, CacheItem | null>(`stickers/items/${encodeURIComponent(`${text} ${color}`)}`)
      // 404 is considered a normal response which means no cache found
      .catch(err => err.response.status === 404 ? null : Promise.reject(err))
    end('check-cache')

    if (cached) {
      stickerFileID = cached.sticker_file_id
    } else {
      // First, create a webp and upload to Telegram server (by sending file to a "hidden" group)
      start('send-sticker')
      const message = await telegram.post<never, TgMessage<'sticker'>>('sendSticker', {
        chat_id: DRIVE_CHAT_ID,
        sticker: `https://${process.env.VERCEL_URL}/api/sticker/${encodeURIComponent(text)}.webp?color=${color}`,
      })
      stickerFileID = message.sticker.file_id
      end('send-sticker')
    }

    await Promise.all([
      // Then, "forward" the uploaded webp to user as inline query result
      // This is the only way we found which is possible to send a sticker via an inline bot
      (async () => {
        start('answer-inline-query')
        await telegram.post('answerInlineQuery', {
          inline_query_id: queryID,
          results: [{
            type: 'sticker',
            id: text,
            sticker_file_id: stickerFileID,
          }],
        })
        end('answer-inline-query')
      })(),
      // If no cache found, insert one into cache database
      (async () => {
        if (cached) return
        start('insert-cache')
        await deta.post(`stickers/items`, {
          item: { key: `${text} ${color}`, sticker_file_id: stickerFileID },
        })
        end('insert-cache')
      })(),
    ])

    console.log({ profile: 'hook', query: req.body.inline_query?.query, ...result() })
  }

  // We don't need to send anything back to Telegram
  res.status(204).end()
}

interface CacheItem {
  key: string
  sticker_file_id: string
}

type TgMessage<T> = {
  message_id: number
  // We don't need other properties
  // ...
} & (
  T extends 'sticker' ? { sticker: TgSticker } : {}
)

interface TgSticker {
  file_id: string
  // We don't need other properties
  // ...
}
