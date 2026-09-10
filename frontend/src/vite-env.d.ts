/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AITWIN_TWIN_ID?: string
  readonly VITE_AITWIN_API_BASE?: string
  readonly VITE_TOPIC_SPEAK: string
  readonly VITE_TOPIC_CHAT: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
