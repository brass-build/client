// Vite plugin encapsulating the bundler config the SDK's WASM runtime
// needs, so users never name the underlying WASM dep in their own
// `vite.config.ts`.
//
// Vite's dep-prebundling targets older browsers by default and fails on the
// WASM dep's top-level await (`Top-level await is not available in the
// configured target environment for loro-crdt/bundler/loro_wasm.js`). The
// plugin excludes the dep from prebundling (leaving it for the build-time
// WASM loaders) and bumps the prebundle target to es2022.
//
// `vite-plugin-wasm` and `vite-plugin-top-level-await` remain the caller's
// responsibility: they must land before `brassVite()` in the plugin list.

// Names of the WASM-shipping deps the SDK pulls in. Append rather
// than replace when adding a new WASM dep: a consumer who has both
// installed during a migration window needs both excluded.
const WASM_DEPS: readonly string[] = ['loro-crdt'];

interface ViteUserConfig {
  optimizeDeps?: {
    exclude?: string[];
    esbuildOptions?: { target?: string };
  };
}

interface VitePlugin {
  name: string;
  config(config: ViteUserConfig): ViteUserConfig;
}

export function brassVite(): VitePlugin {
  return {
    name: 'brass-build:vite',
    config(config) {
      const existingExclude = config.optimizeDeps?.exclude ?? [];
      const exclude = Array.from(new Set([...existingExclude, ...WASM_DEPS]));
      const existingTarget = config.optimizeDeps?.esbuildOptions?.target;
      // Don't downgrade if a consumer has already pinned a newer
      // target; only raise from the Vite default (which lacks TLA).
      const target = existingTarget ?? 'es2022';
      return {
        optimizeDeps: {
          exclude,
          esbuildOptions: { target },
        },
      };
    },
  };
}
