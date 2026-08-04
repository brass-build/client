// Document thumbnail auto-capture: screenshots a registered canvas after each
// local edit settles and uploads it as the thumbnail. One debounce timer, an
// injected uploader, and a one-shot WebGL diagnostic.

// A canvas the SDK screenshots for the thumbnail. A getter form is accepted
// for apps that build or rebuild the canvas lazily.
export type CanvasSource =
  | HTMLCanvasElement
  | (() => HTMLCanvasElement | null);

export type ThumbnailUploader = (
  image: Blob,
  width: number,
  height: number,
) => Promise<void>;

// Debounce window: a screenshot is taken this long after the last local edit,
// so a continuous drag uploads once when it settles, not once per frame.
const THUMBNAIL_CAPTURE_DEBOUNCE_MS = 1500;

// Longest-edge cap (device pixels) for an uploaded thumbnail: a generous
// product ceiling, an upper bound on the size any Brass surface sensibly
// paints a thumbnail at with retina headroom. The largest surface (the
// version-history timeline, ~200px) clears 2x DPR with room, while this still
// sheds the multi-megapixel frames a full-resolution 3D / map / CAD canvas
// would upload. Standalone (not derived from a CSS size) because the display
// sizes live in the frontend and this is a published SDK; a smaller
// per-surface derivative is a server-side concern.
const MAX_THUMBNAIL_CAPTURE_EDGE = 512;

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

  constructor(private readonly host: ThumbnailCaptureHost) {}

  // Register a canvas (element or lazy getter) to screenshot as the thumbnail.
  // Returns an unregister handle; re-registering replaces. The caller
  // (Document) arms its Loro subscriber so local commits reach `schedule()`.
  useCanvas(source: CanvasSource): () => void {
    this._canvas = source;
    // A re-register gets one more chance to surface the missing-buffer warn.
    this._warnedFor = null;
    return () => {
      if (this._canvas === source) {
        this._canvas = null;
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
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      void this._capture();
    }, THUMBNAIL_CAPTURE_DEBOUNCE_MS);
  }

  // Cancel a pending capture (canvas unregistered / suspend / close).
  cancel(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private async _capture(): Promise<void> {
    if (!this.host.isCaptureAllowed()) return;
    if (this._canvas === null) return;
    if (this._uploader === null) return;
    const el =
      typeof this._canvas === 'function' ? this._canvas() : this._canvas;
    if (!el) return;
    this._warnIfWebglContextWillProduceBlankCapture(el);
    try {
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
      if (!this.host.isAttached()) return;
      await this._uploader(image, target.width, target.height);
    } catch {
      // Best-effort: rate-limit rejection, lack of write access, or a
      // transient failure is swallowed; the next local edit reschedules.
    }
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
