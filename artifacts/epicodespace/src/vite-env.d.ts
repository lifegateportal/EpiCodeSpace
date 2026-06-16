/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WEBCONTAINER_APIKEY: string | undefined;
  readonly VITE_APP_URL: string | undefined;
  readonly VITE_ACCESS_PASSWORD_HASH: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
