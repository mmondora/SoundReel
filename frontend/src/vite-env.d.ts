/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __GIT_REVISION__: string;

interface ImportMetaEnv {
  readonly VITE_FUNCTIONS_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
