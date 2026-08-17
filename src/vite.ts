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
// `vite-plugin-wasm` remains the caller's responsibility: it must land before
// `brassVite()` in the plugin list.

// Every WASM-shipping dep the SDK pulls in, and the entry that loads it
// asynchronously. Add an entry rather than replacing the list: a consumer who
// has two installed during a migration window needs both handled, and this is
// the one place any of them is named, so an app's own config never is.
//
// A default browser entry fetches its module with a SYNCHRONOUS
// XMLHttpRequest while it evaluates, so an app freezes its main thread for the
// whole download before it paints, whether or not anyone opens a document, and
// the freeze grows with the reader's latency rather than with the app. An
// `asyncEntry` hands the same module to the bundler's own asset pipeline,
// which loads it asynchronously and leaves the main thread free. Selecting one
// emits a top-level await, so it is reachable only on a build target that
// accepts one, and the synchronous entry is what keeps every other target
// building.
const WASM_DEPS: readonly { specifier: string; asyncEntry: string }[] = [
  { specifier: 'loro-crdt', asyncEntry: 'loro-crdt/bundler' },
];

// A specifier matched whole. A string `find` matches by prefix, which would
// also catch the async entry the alias points AT and resolve it to itself.
const wholeSpecifier = (specifier: string): RegExp =>
  new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

// The shape this plugin reads and returns, declared here rather than imported
// so the SDK does not depend on Vite to describe its own plugin.
//
// Each field has to be at least as WIDE as Vite's own, because Vite passes its
// `UserConfig` into the `config` hook and a hook declared over a narrower
// config is not assignable to Vite's `Plugin`. `target` is the one that bites:
// esbuild types it `string | string[]`, so declaring it `string` makes
// `plugins: [brassVite()]` fail to type-check in a consumer's own
// `vite.config.ts` (verified against Vite 5, 6 and 7; Vite 8 narrowed its own
// type and hid it). The plugin only ever passes the value through, so the
// wider type costs nothing here.
interface ViteAliasEntry {
  find: string | RegExp;
  replacement: string;
}

interface ViteBuildOptions {
  target?: string | string[] | false;
}

interface ViteUserConfig {
  build?: ViteBuildOptions;
  // Vite 8 lets a consumer set the browser build's target per environment, and
  // that value, not the top-level one, is what the client bundle is built to.
  environments?: { client?: { build?: ViteBuildOptions } };
  resolve?: {
    alias?: Record<string, string> | readonly ViteAliasEntry[];
  };
  optimizeDeps?: {
    exclude?: string[];
    esbuildOptions?: { target?: string | string[] };
  };
}

interface VitePlugin {
  name: string;
  config(config: ViteUserConfig): Promise<ViteUserConfig>;
}

// Vite 8 prebundles with rolldown, which handles top-level await on its own
// and deprecates `optimizeDeps.esbuildOptions`. Setting it there does nothing
// except print a deprecation warning naming this plugin, on every `vite dev`
// and every `vite build` a consumer runs. Read from the running Vite rather
// than from the consumer's manifest, and treat an unreadable version as an
// older Vite, where the target bump is what makes the WASM dep load at all.
//
// The specifier is held in a variable so `tsc` does not resolve it. Vite is
// neither a dependency nor a peer dependency here (the config shapes above are
// declared for the same reason), so a literal specifier fails the build
// wherever Vite is absent, which includes `npm install` in this package
// itself. At runtime the import reaches the Vite running the build.
const VITE_PACKAGE = 'vite';

async function viteMajor(): Promise<number | null> {
  try {
    const { version } = (await import(VITE_PACKAGE)) as { version?: string };
    const major = Number.parseInt(version ?? '', 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

// Browser versions that first shipped top-level await, by the engine names
// esbuild accepts in a target string. A target naming an engine absent here is
// read as unsupported.
const TOP_LEVEL_AWAIT_SINCE: Readonly<Record<string, number>> = {
  chrome: 89,
  edge: 89,
  firefox: 89,
  safari: 15,
  ios: 15,
  opera: 75,
  node: 14.8,
  es: 2022,
  hermes: Number.POSITIVE_INFINITY,
  ie: Number.POSITIVE_INFINITY,
};

// Vite's own named targets. `modules` (the Vite 5 / 6 default) resolves to
// browsers predating top-level await; `baseline-widely-available` (the Vite 7 /
// 8 default) resolves to ones that carry it.
const NAMED_TARGET_SUPPORT: Readonly<Record<string, boolean>> = {
  esnext: true,
  'baseline-widely-available': true,
  modules: false,
};

function targetSupportsTopLevelAwait(target: string): boolean {
  const t = target.trim().toLowerCase();
  const named = NAMED_TARGET_SUPPORT[t];
  if (named !== undefined) return named;
  const parsed = /^([a-z]+)([\d.]+)$/.exec(t);
  if (!parsed) return false;
  const since = TOP_LEVEL_AWAIT_SINCE[parsed[1] as string];
  if (since === undefined) return false;
  const version = Number.parseFloat(parsed[2] as string);
  return Number.isFinite(version) && version >= since;
}

// Whether the build this plugin is configuring can carry a top-level await.
// An unreadable or unrecognised target answers `false`, so the worst a wrong
// reading costs is the synchronous entry a consumer already has.
function buildAcceptsTopLevelAwait(
  config: ViteUserConfig,
  major: number | null,
): boolean {
  const target = config.environments?.client?.build?.target ?? config.build?.target;
  // No explicit target: the answer is Vite's own default, which carries
  // top-level await from Vite 7 (`baseline-widely-available`) and not before
  // (`modules`).
  if (target === undefined) return major !== null && major >= 7;
  if (target === false) return false;
  const targets = Array.isArray(target) ? target : [target];
  return targets.length > 0 && targets.every(targetSupportsTopLevelAwait);
}

// A consumer who already resolves the WASM dep themselves owns that decision,
// so the plugin adds nothing that would take it over.
function aliasesWasmDep(config: ViteUserConfig): boolean {
  const alias = config.resolve?.alias;
  if (!alias) return false;
  const specifiers = WASM_DEPS.map((dep) => dep.specifier);
  if (Array.isArray(alias)) {
    return alias.some((entry) =>
      specifiers.some((specifier) =>
        typeof entry.find === 'string'
          ? entry.find === specifier
          : entry.find.test(specifier),
      ),
    );
  }
  return Object.keys(alias as Record<string, string>).some((key) =>
    specifiers.includes(key),
  );
}

export function brassVite(): VitePlugin {
  return {
    name: 'brass-build:vite',
    async config(config) {
      const major = await viteMajor();
      const useAsyncEntry = buildAcceptsTopLevelAwait(config, major) && !aliasesWasmDep(config);
      const existingExclude = config.optimizeDeps?.exclude ?? [];
      const exclude = Array.from(
        new Set([
          ...existingExclude,
          ...WASM_DEPS.map((dep) => dep.specifier),
          ...(useAsyncEntry ? WASM_DEPS.map((dep) => dep.asyncEntry) : []),
        ]),
      );
      const resolve = useAsyncEntry
        ? {
            resolve: {
              alias: WASM_DEPS.map((dep) => ({
                find: wholeSpecifier(dep.specifier),
                replacement: dep.asyncEntry,
              })) as ViteAliasEntry[],
            },
          }
        : {};
      if (major !== null && major >= 8) {
        return { ...resolve, optimizeDeps: { exclude } };
      }
      const existingTarget = config.optimizeDeps?.esbuildOptions?.target;
      // Don't downgrade if a consumer has already pinned a newer
      // target; only raise from the Vite default (which lacks TLA).
      const target = existingTarget ?? 'es2022';
      return {
        ...resolve,
        optimizeDeps: {
          exclude,
          esbuildOptions: { target },
        },
      };
    },
  };
}
