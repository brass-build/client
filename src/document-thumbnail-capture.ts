// Document thumbnail auto-capture: screenshots a registered canvas and uploads
// it as the thumbnail.
//
// The edit trigger debounces a capture after each local commit, so a
// continuous drag uploads once when it settles. The seed trigger covers a
// document whose picture is older than its content: an import writes no local
// commit on the reader's client, and a document nobody has edited yet has none
// at all. It samples the canvas and uploads the frame it settles on, because
// the drawn-but-wrong empty editor is on screen from the first frame (measured
// on the deployed DXF editor: grid at ~0.4s, drawing 0.8s to 4.2s after the
// records land), so neither blankness nor a fixed delay separates the two.

// A canvas the SDK screenshots for the thumbnail. A getter form is accepted
// for apps that build or rebuild the canvas lazily.
export type CanvasSource =
  | HTMLCanvasElement
  | (() => HTMLCanvasElement | null);

// `version` names the document version the image depicts; omitted, the
// uploader reads the document's current version.
export type ThumbnailUploader = (
  image: Blob,
  width: number,
  height: number,
  version?: number,
) => Promise<void>;

// A frame taken from the registered canvas, held until the version it depicts
// is known.
export interface CapturedFrame {
  image: Blob;
  width: number;
  height: number;
}

// Debounce window: a screenshot is taken this long after the last local edit,
// so a continuous drag uploads once when it settles, not once per frame.
const THUMBNAIL_CAPTURE_DEBOUNCE_MS = 1500;

// Seed watch: sample interval, equal samples that count as settled, give-up
// bound, and captures per watch. The window is a bound rather than a wait,
// since the watch ends as soon as it has what it needs; what it sizes is how
// long a document nothing has drawn yet stays worth sampling. A cold
// environment (first load of the bundle, first parse, a slow machine) has been
// measured taking over twenty seconds to draw a 150 KB DXF.
const SEED_SAMPLE_MS = 500;
const SEED_WINDOW_MS = 120_000;
const SEED_SETTLED_SAMPLES = 2;
const SEED_MAX_CAPTURES = 2;

// Edge of the square the fingerprint downsamples to. Small enough that a
// sample costs nothing on the render thread, large enough that a drawing does
// not average away into the background it sits on.
const FINGERPRINT_EDGE = 64;

// Longest-edge cap (device pixels) for an uploaded thumbnail: a generous
// product ceiling, an upper bound on the size any Brass surface sensibly
// paints a thumbnail at with retina headroom. The largest surface (the
// version-history timeline, ~200px) clears 2x DPR with room, while this still
// sheds the multi-megapixel frames a full-resolution 3D / map / CAD canvas
// would upload. Standalone (not derived from a CSS size) because the display
// sizes live in the frontend and this is a published SDK; a smaller
// per-surface derivative is a server-side concern.
const MAX_THUMBNAIL_CAPTURE_EDGE = 512;

// Resolve after the browser paints the next frame. A hidden tab paints none,
// so a short timeout stands in for it there; outside a browser it resolves at
// once.
function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => finish());
    setTimeout(finish, 100);
  });
}

// Cap the longest edge to `maxEdge`, preserving aspect ratio, never upscaling:
// a canvas within the cap is uploaded at native size (`scaled: false`), so the
// common small-canvas case skips the offscreen redraw. The returned dimensions
// are what the uploader reports, so they stay matched to the bytes.
export function fitWithinMaxEdge(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0 || longest <= maxEdge) {
    return { width, height, scaled: false };
  }
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
}

export interface ThumbnailCaptureHost {
  // True when a capture may run: the doc is live (not closed / suspended) and
  // showing head (not a historical checkout), so a viewer or checkout never
  // re-uploads a frame.
  isCaptureAllowed(): boolean;
  // True when the doc is still attached, re-checked after the async toBlob +
  // upload boundary so a capture in flight when the doc closes does not upload.
  isAttached(): boolean;
  // The version the document shows now: what a frame taken now depicts.
  currentVersion(): number | null;
  // Called once an upload lands, so the host can record which version of the
  // document now has a picture: `version` when the upload named one, else the
  // document's current version.
  onCaptured?(version?: number): void;
}

export class ThumbnailCapture {
  // Canvas registered via `useCanvas`; `null` for the common non-canvas app.
  private _canvas: CanvasSource | null = null;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  // The canvas already warned about `preserveDrawingBuffer: false`, so the
  // warn fires once per canvas; reset on `useCanvas` for a re-register.
  private _warnedFor: HTMLCanvasElement | null = null;
  // Injected upload hook (the Document owns no HTTP client). `null` on the
  // offline / test path, where the canvas is tracked but never captured, so
  // apps can register one early without hitting the server in tests.
  private _uploader: ThumbnailUploader | null = null;
  // Seed-watch state: the interval, the fingerprint the watch will not upload,
  // the last sample and how many times it has repeated, the sample budget, and
  // how many frames the watch has captured.
  private _seedTimer: ReturnType<typeof setInterval> | null = null;
  private _seedHeld: string | null = null;
  private _seedLast: string | null = null;
  private _seedRepeats = 0;
  private _seedSamplesLeft = 0;
  private _seedCaptures = 0;
  // A seed was owed while no canvas was registered, so an app that builds its
  // renderer after it has the content still gets one.
  private _seedOwed = false;
  // Whether this instance has landed an upload. Decides whether an edit may
  // supersede a seed watch, and nothing else.
  private _uploaded = false;
  // A failed upload has been reported, so a document the server keeps
  // refusing warns once rather than once per edit.
  private _warnedCaptureFailure = false;
  // Detaches the page-lifecycle listeners while a canvas is registered.
  private _detachLifecycle: (() => void) | null = null;

  constructor(private readonly host: ThumbnailCaptureHost) {}

  // Register a canvas (element or lazy getter) to screenshot as the thumbnail.
  // Returns an unregister handle; re-registering replaces. The caller
  // (Document) arms its Loro subscriber so local commits reach `schedule()`.
  useCanvas(source: CanvasSource): () => void {
    this._canvas = source;
    // A re-register gets one more chance to surface the missing-buffer warn.
    this._warnedFor = null;
    this._attachLifecycle();
    if (this._seedOwed) {
      this._seedOwed = false;
      this.armSeed();
    }
    return () => {
      if (this._canvas === source) {
        this._canvas = null;
        this._detachLifecycle?.();
        this._detachLifecycle = null;
        this.cancel();
      }
    };
  }

  setUploader(uploader: ThumbnailUploader | null): void {
    this._uploader = uploader;
  }

  // Called from the Document's local-commit dispatch; debounces so a burst of
  // edits produces ONE upload when it settles.
  schedule(): void {
    if (this._canvas === null) return;
    // An edit supersedes a seed watch once the document HAS a picture: the
    // person is drawing, so the debounce owns it from here and a second upload
    // of the same moment costs a second snapshot seal. Until then the watch
    // runs on, because an edit is often the reader's last act before they
    // leave, and cancelling on it hands the document's only chance at a
    // picture to a debounce that has to outlive the tab.
    if (this._uploaded) {
      this._stopSeed();
      this._seedOwed = false;
    }
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      void this._capture();
    }, THUMBNAIL_CAPTURE_DEBOUNCE_MS);
  }

  // Called when the document's picture is older than its content: at open, and
  // again whenever content arrives with no local commit behind it. Arming a
  // running watch refreshes its budget, so a burst of arriving ops is one
  // watch that outlives the burst.
  armSeed(): void {
    const el = this._resolveCanvas();
    if (el === null) {
      this._seedOwed = true;
      return;
    }
    this._seedSamplesLeft = Math.ceil(SEED_WINDOW_MS / SEED_SAMPLE_MS);
    if (this._seedTimer !== null) return;
    this._seedHeld = null;
    this._seedLast = null;
    this._seedRepeats = 0;
    this._seedCaptures = 0;
    this._seedTimer = setInterval(() => this._sampleSeed(), SEED_SAMPLE_MS);
  }

  // A page going away is a deadline: take the frame now rather than waiting
  // out a debounce the tab will not survive. `visibilitychange` covers the
  // tab switch as well, which is the case with room for the upload to finish.
  private _attachLifecycle(): void {
    if (this._detachLifecycle !== null) return;
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return;
    }
    const onHidden = (): void => {
      if (document.visibilityState === 'visible') return;
      this._flushPending();
    };
    const onPageHide = (): void => this._flushPending();
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    this._detachLifecycle = () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
    };
  }

  private _flushPending(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
      void this._capture();
      return;
    }
    // A watch holding a frame it has not uploaded takes it, for the same
    // reason its own deadline does: this frame beats no frame.
    if (
      this._seedTimer !== null &&
      this._seedLast !== null &&
      this._seedLast !== this._seedHeld
    ) {
      this._takeSeed(this._seedLast);
    }
  }

  // Cancel a pending capture (canvas unregistered / suspend / close).
  cancel(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._stopSeed();
  }

  // Release for good. The page-lifecycle listeners are held on `document` and
  // `window` rather than on anything the Document owns, so cancelling the
  // timers does not reach them: without this they outlive every closed
  // document, each retaining its uploader closure and firing on every tab
  // switch for the life of the page.
  destroy(): void {
    this.cancel();
    this._detachLifecycle?.();
    this._detachLifecycle = null;
    this._canvas = null;
    this._seedOwed = false;
  }

  private _stopSeed(): void {
    if (this._seedTimer !== null) {
      clearInterval(this._seedTimer);
      this._seedTimer = null;
    }
    this._seedHeld = null;
    this._seedLast = null;
    this._seedRepeats = 0;
  }

  private _sampleSeed(): void {
    if (!this.host.isCaptureAllowed()) {
      this._stopSeed();
      return;
    }
    const el = this._resolveCanvas();
    if (el === null) {
      this._stopSeed();
      this._seedOwed = true;
      return;
    }
    const now = this._fingerprint(el);
    this._seedSamplesLeft -= 1;
    // A canvas with no layout yet is not a frame, so it neither settles nor
    // counts against the budget's meaning; the watch just waits for one.
    if (now === null) {
      if (this._seedSamplesLeft <= 0) this._stopSeed();
      return;
    }
    if (now !== this._seedHeld) {
      if (now === this._seedLast) this._seedRepeats += 1;
      else this._seedRepeats = 0;
      this._seedLast = now;
      if (this._seedRepeats >= SEED_SETTLED_SAMPLES - 1) {
        this._takeSeed(now);
        return;
      }
    }
    if (this._seedSamplesLeft <= 0) {
      // Still redrawing at the deadline: the latest frame is a truer picture
      // of the document than no picture, and a further wait has no end.
      const moved = this._seedLast !== null && this._seedLast !== this._seedHeld;
      if (moved) this._takeSeed(this._seedLast!);
      else this._stopSeed();
    }
  }

  // Upload a settled frame. The first one is a picture of the document, or of
  // the editor about to draw it: an app that mounts its canvas before it has
  // drawn holds an empty grid for as long as the drawing takes. So the watch
  // stays on for a second settle, which lands at the same version and
  // overwrites the first. A third is an app redrawing on its own.
  private _takeSeed(frame: string): void {
    this._seedHeld = frame;
    this._seedRepeats = 0;
    this._seedCaptures += 1;
    if (this._seedCaptures >= SEED_MAX_CAPTURES || this._seedSamplesLeft <= 0) {
      this._stopSeed();
    }
    void this._capture();
  }

  // A cheap perceptual fingerprint: the canvas downsampled into a small square
  // and folded into a string. It reads through the same front buffer `toBlob`
  // does, so a canvas the capture would read blank fingerprints blank too and
  // the watch expires instead of uploading it.
  private _fingerprint(el: HTMLCanvasElement): string | null {
    // A canvas the page has not laid out yet (the browser's 1x1 default until
    // the app sizes it) carries no frame to compare.
    if (el.width <= 1 || el.height <= 1) return null;
    try {
      const off = document.createElement('canvas');
      off.width = FINGERPRINT_EDGE;
      off.height = FINGERPRINT_EDGE;
      const ctx = off.getContext('2d', { willReadFrequently: true });
      if (!ctx) return 'unreadable';
      ctx.drawImage(el, 0, 0, FINGERPRINT_EDGE, FINGERPRINT_EDGE);
      const { data } = ctx.getImageData(0, 0, FINGERPRINT_EDGE, FINGERPRINT_EDGE);
      let h1 = 0x811c9dc5;
      let h2 = 0x01000193;
      for (let i = 0; i < data.length; i += 4) {
        const px = (data[i]! << 24) | (data[i + 1]! << 16) | (data[i + 2]! << 8) | data[i + 3]!;
        h1 = Math.imul(h1 ^ px, 0x01000193);
        h2 = Math.imul(h2 + px, 0x85ebca6b) ^ (h2 >>> 13);
      }
      return `${h1 >>> 0}:${h2 >>> 0}`;
    } catch {
      // A tainted canvas throws here exactly as it would in the capture, so
      // treating every read as the same value expires the watch.
      return 'unreadable';
    }
  }

  private _resolveCanvas(): HTMLCanvasElement | null {
    if (this._canvas === null) return null;
    return typeof this._canvas === 'function' ? this._canvas() : this._canvas;
  }

  // Take a frame for a checkpoint: on the next animation frame, so the redraw
  // the app makes for the action it just finished is in the picture. The
  // frame supersedes a pending debounced capture, since it depicts the same
  // edits; an edit after it schedules a new one. Null when there is no canvas
  // or nothing may be captured.
  async captureFrame(): Promise<CapturedFrame | null> {
    if (this._canvas === null || this._uploader === null) return null;
    if (!this.host.isCaptureAllowed()) return null;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    // Once the document has a picture, a checkpoint's frame supersedes a seed
    // watch the way an edit does (see `schedule`).
    if (this._uploaded) {
      this._stopSeed();
      this._seedOwed = false;
    }
    await nextFrame();
    try {
      return await this._render();
    } catch (err) {
      this._warnFailure(err);
      return null;
    }
  }

  // Upload a frame taken by `captureFrame` as the picture of `version`.
  async uploadFrame(frame: CapturedFrame, version: number): Promise<void> {
    if (this._uploader === null || !this.host.isAttached()) return;
    try {
      await this._uploader(frame.image, frame.width, frame.height, version);
      this._uploaded = true;
      this.host.onCaptured?.(version);
    } catch (err) {
      this._warnFailure(err);
    }
  }

  private async _render(): Promise<CapturedFrame | null> {
    const el = this._resolveCanvas();
    if (!el) return null;
    this._warnIfWebglContextWillProduceBlankCapture(el);
    const target = fitWithinMaxEdge(
      el.width,
      el.height,
      MAX_THUMBNAIL_CAPTURE_EDGE,
    );
    const source = target.scaled ? this._downscale(el, target) : el;
    const image = await new Promise<Blob>((resolve, reject) => {
      source.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('thumbnail capture: canvas produced no image'));
      }, 'image/png');
    });
    return { image, width: target.width, height: target.height };
  }

  private async _capture(): Promise<void> {
    if (!this.host.isCaptureAllowed()) return;
    if (this._uploader === null) return;
    // Read before the frame is taken, so the upload names the version the
    // frame depicts rather than whatever the document reached while the
    // image encoded.
    const version = this.host.currentVersion();
    try {
      const frame = await this._render();
      if (frame === null || !this.host.isAttached()) return;
      if (version === null) {
        await this._uploader(frame.image, frame.width, frame.height);
      } else {
        await this._uploader(frame.image, frame.width, frame.height, version);
      }
      this._uploaded = true;
      this.host.onCaptured?.(version ?? undefined);
    } catch (err) {
      this._warnFailure(err);
    }
  }

  // Best-effort: a rate-limit rejection, a lack of write access, or a
  // transient failure leaves the document on its last picture, and the next
  // edit or arrival reschedules. Reported once, because the refusals that
  // persist (no write access, an oversized image) are otherwise
  // indistinguishable from a capture that never ran.
  private _warnFailure(err: unknown): void {
    if (this._warnedCaptureFailure) return;
    this._warnedCaptureFailure = true;
    console.warn(
      '@brass-build/client: uploading the document thumbnail failed: ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  // Redraw an oversized canvas into an offscreen 2D canvas at the capped
  // dimensions. `drawImage` reads the source's front buffer, so the WebGL
  // `preserveDrawingBuffer` caveat above applies here too. If a 2D context
  // can't be acquired, fall back to the full-resolution source: one oversized
  // upload beats a missing thumbnail.
  private _downscale(
    el: HTMLCanvasElement,
    target: { width: number; height: number },
  ): HTMLCanvasElement {
    const off = document.createElement('canvas');
    off.width = target.width;
    off.height = target.height;
    const ctx = off.getContext('2d');
    if (!ctx) return el;
    ctx.drawImage(el, 0, 0, target.width, target.height);
    return off;
  }

  // Warn once per canvas if its WebGL context lacks
  // `preserveDrawingBuffer: true`: without it `toBlob` reads back a blank
  // frame (the spec lets the browser discard the drawing buffer after
  // compositing), so the upload silently stores a blank PNG with no
  // diagnostic. Harmless on 2D / SVG canvases (no WebGL context to inspect).
  private _warnIfWebglContextWillProduceBlankCapture(
    el: HTMLCanvasElement,
  ): void {
    if (this._warnedFor === el) return;
    if (typeof el.getContext !== 'function') return;
    let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
    try {
      gl =
        (el.getContext('webgl2') as WebGL2RenderingContext | null) ??
        (el.getContext('webgl') as WebGLRenderingContext | null);
    } catch {
      return;
    }
    if (!gl) return;
    const attributes = gl.getContextAttributes();
    if (attributes && attributes.preserveDrawingBuffer === false) {
      this._warnedFor = el;
      console.warn(
        '@brass-build/client: useCanvas captured a blank thumbnail because ' +
          'the WebGL context was created with preserveDrawingBuffer: false. ' +
          'Pass preserveDrawingBuffer: true when creating the WebGL context ' +
          '(e.g., new THREE.WebGLRenderer({ preserveDrawingBuffer: true })).',
      );
    }
  }
}
