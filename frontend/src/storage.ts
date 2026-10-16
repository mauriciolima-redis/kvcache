// Conversations live in localStorage (the backend is stateless apart from Redis), so the
// chat and the analysis page share these types and the storage key.
import type { Metrics, Role } from './api'
import type { Lang } from './i18n'

export interface UiMessage {
  role: Role
  // Exact text sent to the model (for an upload: prompt + file contents).
  content: string
  // Set when the message came from an upload; the bubble shows a file chip + prompt
  // instead of dumping the whole document.
  file?: { name: string; chars: number }
  prompt?: string
  metrics?: Metrics
  error?: string
}

export interface Conversation {
  id: string
  title: string
  // Fixed at creation: it selects the backend system prompt, and changing the system
  // prompt mid-conversation would invalidate the whole KV cache prefix.
  // Missing on conversations saved before i18n, which were all pt-BR.
  lang?: Lang
  // KVCache toggle for this conversation; missing on chats saved before it was per-chat.
  kvCache?: boolean
  messages: UiMessage[]
}

export const STORAGE_KEY = 'kvchat.conversations'

export function readConversations(): Conversation[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as Conversation[]
  } catch {
    return []
  }
}
