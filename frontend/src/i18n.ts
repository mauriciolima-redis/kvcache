import type { Metrics } from './api'

export type Lang = 'pt-BR' | 'en-US'

export const LANGS: { lang: Lang; slug: string; short: string }[] = [
  { lang: 'pt-BR', slug: 'pt-br', short: 'PT' },
  { lang: 'en-US', slug: 'en-us', short: 'EN' },
]

const LANG_KEY = 'kvchat.lang'
const DEFAULT_LANG: Lang = 'pt-BR'

/** Resolution order: URL path (/pt-br, /en-us) > last choice > browser language > default. */
export function detectLang(): Lang {
  const slug = window.location.pathname.split('/')[1]?.toLowerCase()
  const fromPath = LANGS.find((l) => l.slug === slug)?.lang
  if (fromPath) return fromPath
  const saved = localStorage.getItem(LANG_KEY) as Lang | null
  if (saved && LANGS.some((l) => l.lang === saved)) return saved
  return navigator.language.toLowerCase().startsWith('en') ? 'en-US' : DEFAULT_LANG
}

/** Persist the choice and reflect it in the URL without a reload. */
export function applyLang(lang: Lang, mode: 'push' | 'replace' = 'push') {
  localStorage.setItem(LANG_KEY, lang)
  document.documentElement.lang = lang
  const path = `/${LANGS.find((l) => l.lang === lang)!.slug}`
  if (window.location.pathname !== path) window.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', path)
}

type StatusKey = Metrics['cache_status']

export interface Messages {
  newChat: string
  deleteChat: string
  sidebarFoot: string
  emptyTitleBefore: string
  emptyTitleHighlight: string
  emptyTitleAfter: string
  emptyTipBefore: string
  emptyTipAfter: string
  thinking: string
  error: string
  placeholder: string
  send: string
  stop: string
  hint: string
  language: string
  cacheOn: string
  cacheOff: string
  firstToken: string
  groupLlm: string
  groupTokens: string
  groupTotals: string
  colBoth: string
  colCache: string
  cacheOnly: string
  renameChat: string
  compare: string
  compareGenerate: string
  compareCancel: string
  compareHint: string
  compareNoData: string
  analysis: {
    title: string
    subtitle: string
    notFound: string
    needTwo: string
    metric: string
    baseline: string
    linesTitle: string
    deltaTitle: string
    deltaSubtitle: string
    tableTitle: string
    reply: string
    total: string
    vsBase: string
    better: string
    worse: string
    same: string
    base: string
    noValue: string
    localOnly: string
    metrics: Record<'ttft' | 'wait' | 'llm' | 'read', { label: string; help: string }>
  }
  showTotals: string
  hideTotals: string
  turnsValue: string
  attach: string
  attachHelp: string
  attachOnlyFirst: string
  removeFile: string
  fileType: string
  fileTooLarge: string
  fileEmpty: string
  filePrompt: string
  fileChars: string
  status: Record<StatusKey, { tag: string; help: string }>
  labels: {
    llmTime: string
    redisLoad: string
    redisSave: string
    promptTotal: string
    read: string
    reused: string
    cacheBytes: string
    turns: string
    ttftSum: string
    llmTimeSum: string
    redisLoadSum: string
    redisSaveSum: string
    cacheBytesNow: string
    readSum: string
    reusedSum: string
  }
  help: Messages['labels'] & { ttft: string }
}

const ptBR: Messages = {
  newChat: 'Nova conversa',
  deleteChat: 'Apagar conversa e KV cache',
  sidebarFoot: 'KV cache persistido no Redis',
  emptyTitleBefore: 'Como posso ',
  emptyTitleHighlight: 'ajudar',
  emptyTitleAfter: '?',
  emptyTipBefore:
    'Dica: comece colando um texto longo (um artigo, por exemplo) e depois faça perguntas curtas. Ligue e desligue o ',
  emptyTipAfter: ' para comparar o tempo até a primeira palavra.',
  thinking: 'pensando…',
  error: 'Erro',
  placeholder: 'Envie uma mensagem…',
  send: 'Enviar',
  stop: 'Parar',
  hint: 'Tempos medidos no backend: apenas execução do LLM, sem rede.',
  language: 'Idioma',
  cacheOn: 'KVCache ligado · Redis',
  cacheOff: 'KVCache desligado · padrão',
  firstToken: 'Espera até a 1ª palavra',
  groupLlm: 'LLM',
  groupTokens: 'Processamento de tokens',
  groupTotals: 'Total do chat',
  colBoth: 'Com e sem KVCache',
  colCache: 'Só com KVCache',
  cacheOnly: 'Só é medido com o KVCache ligado.',
  renameChat: 'Renomear conversa',
  compare: 'Comparar conversas',
  compareGenerate: 'Gerar gráfico ({n})',
  compareCancel: 'Cancelar',
  compareHint: 'Marque de 2 a 4 conversas.',
  compareNoData: 'Esta conversa ainda não tem respostas.',
  analysis: {
    title: 'Análise de conversas',
    subtitle: 'Cada ponto é uma resposta. Menor é melhor em todas as métricas.',
    notFound: 'Conversa não encontrada neste navegador',
    needTwo: 'Escolha pelo menos 2 conversas com respostas para comparar.',
    metric: 'Métrica',
    baseline: 'Base de comparação',
    linesTitle: '{metric} por resposta',
    deltaTitle: 'Variação em relação a {base}',
    deltaSubtitle: 'Abaixo de 0% = mais rápido (melhora). Acima de 0% = mais lento (piora).',
    tableTitle: 'Valores por resposta',
    reply: 'Resposta',
    total: 'Total',
    vsBase: 'vs base',
    better: 'melhor',
    worse: 'pior',
    same: 'igual',
    base: 'base',
    noValue: '—',
    localOnly: 'Os dados vêm das conversas salvas neste navegador.',
    metrics: {
      ttft: {
        label: 'Espera até a 1ª palavra',
        help: 'Tempo até aparecer a primeira palavra da resposta.',
      },
      wait: {
        label: 'Espera + busca no Redis',
        help: 'Espera até a 1ª palavra somada à busca da memória no Redis: a espera real de quem usa o chat.',
      },
      llm: { label: 'Tempo total da resposta', help: 'Tempo para ler a conversa e escrever a resposta inteira.' },
      read: { label: 'Tokens lidos', help: 'Quantos tokens o modelo precisou ler em cada resposta.' },
    },
  },
  showTotals: '+ Total do chat',
  hideTotals: '− Ocultar total do chat',
  turnsValue: '{n} ({c} com KVCache)',
  attach: 'Anexar',
  attachHelp: 'Anexe um arquivo .txt ou .md (até {max}). Ele entra como a primeira mensagem da conversa.',
  attachOnlyFirst: 'Arquivos só podem ser enviados na primeira mensagem. Crie uma nova conversa.',
  removeFile: 'Remover arquivo',
  fileType: 'Formato não suportado: use .txt ou .md.',
  fileTooLarge: 'Arquivo muito grande ({size}). O limite é {max}.',
  fileEmpty: 'O arquivo está vazio.',
  filePrompt: 'Leia o documento a seguir e aguarde minhas perguntas.',
  fileChars: '{n} caracteres',
  status: {
    off: {
      tag: 'cache descartável',
      help: 'Cache padrão da biblioteca (mlx_lm): criado para esta resposta e descartado no fim. A conversa inteira é relida a cada mensagem.',
    },
    hit: {
      tag: 'cache encontrado',
      help: 'Havia KV cache salvo no Redis para esta conversa e ele foi reaproveitado.',
    },
    miss: {
      tag: 'primeira leitura',
      help: 'Não havia KV cache salvo (primeira mensagem com o cache ligado ou cache expirado). Ele foi criado e salvo no Redis.',
    },
    reset: { tag: 'cache reiniciado', help: 'O KV cache salvo não pôde ser reaproveitado e foi recriado.' },
  },
  labels: {
    llmTime: 'Tempo total da resposta',
    redisLoad: 'Busca da memória no Redis',
    redisSave: 'Gravação da memória no Redis',
    promptTotal: 'Tamanho da conversa',
    read: 'Lidos agora',
    reused: 'Reaproveitados da memória',
    cacheBytes: 'Memória salva no Redis',
    turns: 'Respostas',
    ttftSum: 'Espera somada até a 1ª palavra',
    llmTimeSum: 'Tempo somado das respostas',
    redisLoadSum: 'Busca somada no Redis',
    redisSaveSum: 'Gravação somada no Redis',
    cacheBytesNow: 'Memória no Redis agora',
    readSum: 'Tokens lidos',
    reusedSum: 'Tokens reaproveitados',
  },
  help: {
    ttft: 'Quanto tempo se espera até aparecer a primeira palavra da resposta. Inclui o modelo ler a parte da conversa que não estava na memória.',
    llmTime: 'Quanto tempo o modelo levou para ler a conversa e escrever a resposta inteira.',
    redisLoad: 'Tempo para trazer do Redis a memória já calculada desta conversa, antes de responder.',
    redisSave: 'Tempo para guardar no Redis a memória atualizada, depois de responder.',
    promptTotal: 'Tamanho da conversa até aqui, em tokens (pedaços de palavras que o modelo lê).',
    read: 'Quantos tokens o modelo precisou ler para esta resposta. Quanto menos, mais rápido.',
    reused: 'Tokens que o modelo não precisou reler, porque já estavam na memória salva no Redis.',
    cacheBytes: 'Espaço que a memória desta conversa ocupa no Redis.',
    turns: 'Quantas respostas esta conversa já teve, e quantas com o KVCache ligado.',
    ttftSum: 'Soma das esperas até a primeira palavra em todas as respostas desta conversa.',
    llmTimeSum: 'Soma do tempo de todas as respostas desta conversa.',
    redisLoadSum: 'Soma do tempo gasto trazendo a memória do Redis nesta conversa.',
    redisSaveSum: 'Soma do tempo gasto guardando a memória no Redis nesta conversa.',
    cacheBytesNow: 'Espaço que a memória desta conversa ocupa no Redis depois desta resposta.',
    readSum: 'Soma dos tokens que o modelo precisou ler em todas as respostas.',
    reusedSum: 'Soma dos tokens que não precisaram ser relidos graças à memória no Redis.',
  },
}

const enUS: Messages = {
  newChat: 'New chat',
  deleteChat: 'Delete chat and KV cache',
  sidebarFoot: 'KV cache persisted in Redis',
  emptyTitleBefore: 'How can I ',
  emptyTitleHighlight: 'help',
  emptyTitleAfter: '?',
  emptyTipBefore:
    'Tip: start by pasting a long text (an article, for example), then ask short questions. Toggle ',
  emptyTipAfter: ' on and off to compare the time to first token.',
  thinking: 'thinking…',
  error: 'Error',
  placeholder: 'Send a message…',
  send: 'Send',
  stop: 'Stop',
  hint: 'Times measured on the backend: LLM execution only, no network.',
  language: 'Language',
  cacheOn: 'KVCache on · Redis',
  cacheOff: 'KVCache off · default',
  firstToken: 'Time to first word',
  groupLlm: 'LLM',
  groupTokens: 'Token processing',
  groupTotals: 'Chat total',
  colBoth: 'With and without KVCache',
  colCache: 'Only with KVCache',
  cacheOnly: 'Only measured with KVCache on.',
  renameChat: 'Rename chat',
  compare: 'Compare chats',
  compareGenerate: 'Generate chart ({n})',
  compareCancel: 'Cancel',
  compareHint: 'Pick 2 to 4 chats.',
  compareNoData: 'This chat has no replies yet.',
  analysis: {
    title: 'Chat analysis',
    subtitle: 'Each point is one reply. Lower is better for every metric.',
    notFound: 'Chat not found in this browser',
    needTwo: 'Pick at least 2 chats with replies to compare.',
    metric: 'Metric',
    baseline: 'Baseline',
    linesTitle: '{metric} per reply',
    deltaTitle: 'Change relative to {base}',
    deltaSubtitle: 'Below 0% = faster (improvement). Above 0% = slower (regression).',
    tableTitle: 'Values per reply',
    reply: 'Reply',
    total: 'Total',
    vsBase: 'vs baseline',
    better: 'better',
    worse: 'worse',
    same: 'same',
    base: 'baseline',
    noValue: '—',
    localOnly: 'Data comes from the chats saved in this browser.',
    metrics: {
      ttft: { label: 'Time to first word', help: 'Time until the first word of the reply appears.' },
      wait: {
        label: 'Wait + Redis load',
        help: 'Time to first word plus loading memory from Redis: the real wait of whoever is chatting.',
      },
      llm: { label: 'Total reply time', help: 'Time to read the conversation and write the whole reply.' },
      read: { label: 'Tokens read', help: 'How many tokens the model had to read for each reply.' },
    },
  },
  showTotals: '+ Chat total',
  hideTotals: '− Hide chat total',
  turnsValue: '{n} ({c} with KVCache)',
  attach: 'Attach',
  attachHelp: 'Attach a .txt or .md file (up to {max}). It becomes the first message of the conversation.',
  attachOnlyFirst: 'Files can only be sent as the first message. Start a new chat.',
  removeFile: 'Remove file',
  fileType: 'Unsupported format: use .txt or .md.',
  fileTooLarge: 'File too large ({size}). The limit is {max}.',
  fileEmpty: 'The file is empty.',
  filePrompt: 'Read the following document and wait for my questions.',
  fileChars: '{n} characters',
  status: {
    off: {
      tag: 'discarded cache',
      help: 'Library default cache (mlx_lm): created for this reply and discarded at the end. The whole conversation is re-read on every message.',
    },
    hit: { tag: 'cache hit', help: 'A KV cache for this conversation was found in Redis and reused.' },
    miss: {
      tag: 'first read',
      help: 'No KV cache was stored (first message with cache on, or the cache expired). It was created and saved to Redis.',
    },
    reset: { tag: 'cache reset', help: 'The stored KV cache could not be reused and was rebuilt.' },
  },
  labels: {
    llmTime: 'Total reply time',
    redisLoad: 'Memory load from Redis',
    redisSave: 'Memory save to Redis',
    promptTotal: 'Conversation size',
    read: 'Read now',
    reused: 'Reused from memory',
    cacheBytes: 'Memory stored in Redis',
    turns: 'Replies',
    ttftSum: 'Total wait to first word',
    llmTimeSum: 'Sum of reply times',
    redisLoadSum: 'Total Redis load',
    redisSaveSum: 'Total Redis save',
    cacheBytesNow: 'Memory in Redis now',
    readSum: 'Tokens read',
    reusedSum: 'Tokens reused',
  },
  help: {
    ttft: 'How long you wait until the first word of the reply appears. Includes the model reading the part of the conversation that was not in memory.',
    llmTime: 'How long the model took to read the conversation and write the whole reply.',
    redisLoad: 'Time to bring this conversation’s already-computed memory from Redis, before replying.',
    redisSave: 'Time to store the updated memory in Redis, after replying.',
    promptTotal: 'Size of the conversation so far, in tokens (word pieces the model reads).',
    read: 'How many tokens the model had to read for this reply. Fewer means faster.',
    reused: 'Tokens the model did not have to re-read because they were already in the memory stored in Redis.',
    cacheBytes: 'Space this conversation’s memory takes in Redis.',
    turns: 'How many replies this conversation has had, and how many with KVCache on.',
    ttftSum: 'Sum of the waits until the first word across all replies in this conversation.',
    llmTimeSum: 'Sum of the time of all replies in this conversation.',
    redisLoadSum: 'Sum of the time spent loading memory from Redis in this conversation.',
    redisSaveSum: 'Sum of the time spent storing memory in Redis in this conversation.',
    cacheBytesNow: 'Space this conversation’s memory takes in Redis after this reply.',
    readSum: 'Sum of the tokens the model had to read across all replies.',
    reusedSum: 'Sum of the tokens that did not need re-reading thanks to the memory in Redis.',
  },
}

export const MESSAGES: Record<Lang, Messages> = { 'pt-BR': ptBR, 'en-US': enUS }

export function formatters(lang: Lang) {
  const num = (n: number, digits = 0) =>
    n.toLocaleString(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return {
    int: (n: number | null | undefined) => (n == null ? '–' : num(n)),
    ms: (ms: number | null | undefined) =>
      ms == null ? '–' : ms >= 1000 ? `${num(ms / 1000, 2)} s` : `${num(ms)} ms`,
    bytes: (b: number | null | undefined) => {
      if (b == null) return '–'
      if (b >= 1024 ** 3) return `${num(b / 1024 ** 3, 2)} GB`
      if (b >= 1024 ** 2) return `${num(b / 1024 ** 2, 1)} MB`
      if (b >= 1024) return `${num(b / 1024, 1)} KB`
      return `${b} B`
    },
    fixed: num,
  }
}

/** Replace {name} placeholders in a message string. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? `{${k}}`)
}
