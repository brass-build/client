// Frozen bytes kept across opens, keyed by the `content_id` a join names them
// by.
//
// A join signs a new URL for the same bytes every time, so the URL cannot key
// anything and the browser's HTTP cache never hits. The id can: it names the
// content, and every copy the server stores of the same content carries the
// same id, so a join that answers an id already held is answered from the
// copy. The join itself is still made, which is where access
// is checked; nothing here is read without a join naming it first.
//
// Two tiers. Memory holds the buffers this page already decoded, which is
// what a re-open inside one page needs, and costs nothing while the document
// that decoded them is still open (it holds the same buffer). Cache Storage
// holds them across page loads, which is what a reader returning to a result
// needs. Either can be missing or refuse (no secure context, a private window,
// quota), and a refusal reads as a miss: the bytes are then downloaded, as
// they would be with no cache at all.
//
// Cache Storage outlives the page, so the identity that filled it is recorded
// beside the bytes (`adoptSealedCacheOwner`). A page that resolves a different
// identity, or none, drops the whole cache before reading from it: a sign-out
// in this page clears it on the spot, but a session that ended with the tab
// closed reaches the next person only as a new page load.

/** Fetches a signed URL's body. */
export type SealedFetch = (url: string) => Promise<Uint8Array>;

const CACHE_NAME = 'brass-sealed-v1';
// A request URL Cache Storage accepts, on a host that cannot resolve, so an
// entry is never confused with a response the page fetched.
const ENTRY_BASE = 'https://sealed.brass.invalid/';
// The identity the kept bytes were downloaded for, read synchronously so the
// check settles before any open can read the cache.
const OWNER_KEY = 'brass:sealed-owner';
const PERSISTENT_BUDGET_BYTES = 512 * 1024 * 1024;
const MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;

interface CacheLike {
  match(request: string, options?: { ignoreSearch?: boolean }): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  delete(request: string, options?: { ignoreSearch?: boolean }): Promise<boolean>;
  keys(): Promise<readonly { url: string }[]>;
}

interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  delete(name: string): Promise<boolean>;
}

function cacheStorage(): CacheStorageLike | null {
  try {
    const storage = (globalThis as { caches?: CacheStorageLike }).caches;
    return storage && typeof storage.open === 'function' ? storage : null;
  } catch {
    return null;
  }
}

// Insertion order is use order: a hit moves its entry to the end.
const memory = new Map<string, Uint8Array>();
let memoryBytes = 0;
const inFlight = new Map<string, Promise<Uint8Array>>();
// Bumped by a clear, so a fetch that began before it does not write the
// previous person's bytes back afterwards.
let generation = 0;
// Cache Storage writes still landing, by id. A delete waits for the write to
// its id first: a write that lands after the delete puts back exactly the
// copy the delete was removing.
const writing = new Map<string, Promise<void>>();
// The latest drop of Cache Storage. Reads and writes wait for it, so nothing
// is read from a cache being dropped and no write lands in it before the drop.
// A drop waits only for writes registered before it, and a write only for
// drops begun before it, so neither waits on the other in a cycle.
let ownership: Promise<void> = Promise.resolve();

function rememberInMemory(id: string, bytes: Uint8Array): void {
  const held = memory.get(id);
  if (held !== undefined) {
    memory.delete(id);
    memoryBytes -= held.byteLength;
  }
  if (bytes.byteLength > MEMORY_BUDGET_BYTES) return;
  memory.set(id, bytes);
  memoryBytes += bytes.byteLength;
  for (const [oldest, old] of memory) {
    if (memoryBytes <= MEMORY_BUDGET_BYTES) break;
    memory.delete(oldest);
    memoryBytes -= old.byteLength;
  }
}

function entryUrl(id: string): string {
  return ENTRY_BASE + encodeURIComponent(id);
}

async function readPersistent(id: string): Promise<Uint8Array | null> {
  await ownership;
  const storage = cacheStorage();
  if (storage === null) return null;
  try {
    const cache = await storage.open(CACHE_NAME);
    const hit = await cache.match(entryUrl(id), { ignoreSearch: true });
    if (hit === undefined) return null;
    return new Uint8Array(await hit.arrayBuffer());
  } catch {
    return null;
  }
}

async function writePersistent(id: string, bytes: Uint8Array, startedIn: number): Promise<void> {
  await ownership;
  const storage = cacheStorage();
  if (storage === null || bytes.byteLength > PERSISTENT_BUDGET_BYTES) return;
  try {
    const cache = await storage.open(CACHE_NAME);
    if (generation !== startedIn) return;
    // The size and the time ride in the entry's query, which a lookup ignores,
    // so the budget is kept from the key listing without reading any body.
    await cache.put(
      `${entryUrl(id)}?b=${bytes.byteLength}&t=${Date.now()}`,
      new Response(bytes as unknown as BodyInit, {
        headers: { 'content-type': 'application/octet-stream' },
      }),
    );
    await trimPersistent(cache);
  } catch {
    // Quota, a private window, a closed storage: the bytes are still in hand.
  }
}

async function trimPersistent(cache: CacheLike): Promise<void> {
  const entries = (await cache.keys()).map((request) => {
    const url = new URL(request.url);
    return {
      url: request.url,
      bytes: Number(url.searchParams.get('b')) || 0,
      at: Number(url.searchParams.get('t')) || 0,
    };
  });
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  entries.sort((a, b) => a.at - b.at);
  for (const entry of entries) {
    if (total <= PERSISTENT_BUDGET_BYTES) break;
    await cache.delete(entry.url);
    total -= entry.bytes;
  }
}

/**
 * The bytes a join names, from a kept copy when one is held, else from `url`.
 *
 * With no `contentId` this is `fetchBody(url)`: content nothing names cannot
 * be recognised the next time. Concurrent asks for one id share a download.
 */
export function fetchSealedBytes(
  contentId: string | undefined,
  url: string,
  fetchBody: SealedFetch,
): Promise<Uint8Array> {
  if (contentId === undefined || contentId === '') return fetchBody(url);
  const held = memory.get(contentId);
  if (held !== undefined) {
    rememberInMemory(contentId, held);
    return Promise.resolve(held);
  }
  const pending = inFlight.get(contentId);
  if (pending !== undefined) return pending;
  const startedIn = generation;
  const load = (async () => {
    const kept = await readPersistent(contentId);
    if (kept !== null) {
      if (generation === startedIn) rememberInMemory(contentId, kept);
      return kept;
    }
    const bytes = await fetchBody(url);
    if (generation === startedIn) {
      rememberInMemory(contentId, bytes);
      const write = writePersistent(contentId, bytes, startedIn);
      writing.set(contentId, write);
      void write.then(() => {
        if (writing.get(contentId) === write) writing.delete(contentId);
      });
    }
    return bytes;
  })();
  inFlight.set(contentId, load);
  void load.then(
    () => inFlight.delete(contentId),
    () => inFlight.delete(contentId),
  );
  return load;
}

/** Drop one id from both tiers, for a kept copy that would not decode. */
export async function forgetSealedBytes(contentId: string): Promise<void> {
  const held = memory.get(contentId);
  if (held !== undefined) {
    memory.delete(contentId);
    memoryBytes -= held.byteLength;
  }
  await writing.get(contentId);
  const storage = cacheStorage();
  if (storage === null) return;
  try {
    const cache = await storage.open(CACHE_NAME);
    await cache.delete(entryUrl(contentId), { ignoreSearch: true });
  } catch {
    // Nothing kept, or nothing to reach.
  }
}

/** Drop every kept copy, whoever the recorded owner is: the drop
 *  `adoptSealedCacheOwner` makes on a change of owner, made unconditionally. */
export function clearSealedCache(): void {
  void dropEverything();
}

function dropEverything(): Promise<void> {
  generation += 1;
  memory.clear();
  memoryBytes = 0;
  inFlight.clear();
  const storage = cacheStorage();
  if (storage === null) return ownership;
  const landing = [...writing.values()];
  const drop = Promise.allSettled([ownership, ...landing])
    .then(() => storage.delete(CACHE_NAME))
    .then(
      () => undefined,
      () => undefined,
    );
  ownership = drop;
  return drop;
}

function ownerStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Record whose bytes the cache keeps: the signed-in person's `sub`, or `null`
 * signed out. A cache recorded for anyone else, or for no one, is dropped
 * before anything reads it.
 */
export function adoptSealedCacheOwner(owner: string | null): void {
  const mark = owner === null ? 'signed-out' : `sub:${owner}`;
  const storage = ownerStorage();
  let held: string | null = null;
  try {
    held = storage?.getItem(OWNER_KEY) ?? null;
  } catch {
    held = null;
  }
  if (held === mark) return;
  // Unrecorded counts as someone else: bytes kept before any owner was
  // recorded cannot say whose they are.
  void dropEverything();
  try {
    storage?.setItem(OWNER_KEY, mark);
  } catch {
    // Unrecorded, so the next page drops the cache again rather than trust it.
  }
}
