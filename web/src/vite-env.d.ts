/// <reference types="vite/client" />

// Typed access to import.meta.env.VITE_* so api.ts does not fall back to any.
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
