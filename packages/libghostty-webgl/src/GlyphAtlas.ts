export interface GlyphMetrics {
  atlasX: number;
  atlasY: number;
  atlasW: number;
  atlasH: number;
  bearingX: number;
  bearingY: number;
  width: number;
  height: number;
  isColor: boolean;
}

interface Shelf {
  y: number;
  height: number;
  nextX: number;
}

interface AtlasPage {
  width: number;
  height: number;
  shelves: Shelf[];
  nextShelfY: number;
}

interface GlyphEntry extends GlyphMetrics {
  key: string;
  grapheme: string;
  bold: boolean;
  italic: boolean;
  isColor: boolean;
  pinned: boolean;
  lastUsed: number;
}

interface GlyphRequest {
  grapheme: string;
  bold: boolean;
  italic: boolean;
  isColor: boolean;
  pinned: boolean;
}

const PADDING = 1;
const ASCII_START = 32;
const ASCII_END = 126;

export class GlyphAtlas {
  private gl: WebGL2RenderingContext;
  private fontSize: number;
  private fontFamily: string;
  private dpr: number;
  private atlasSize: number;
  private colorAtlasSize: number;
  private atlasTexture: WebGLTexture;
  private colorTexture: WebGLTexture;
  private page: AtlasPage;
  private colorPage: AtlasPage;
  private glyphs: Map<string, GlyphEntry> = new Map();
  private useCounter = 0;
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private colorCanvas: HTMLCanvasElement | OffscreenCanvas;
  private colorCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  constructor(gl: WebGL2RenderingContext, fontSize: number, fontFamily: string, dpr: number) {
    this.gl = gl;
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.dpr = dpr;

    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const baseSize = 2048;
    this.atlasSize = Math.min(baseSize, maxSize);
    this.colorAtlasSize = Math.min(baseSize, maxSize);

    const atlasTexture = gl.createTexture();
    const colorTexture = gl.createTexture();
    if (!atlasTexture || !colorTexture) {
      throw new Error("Failed to create glyph atlas textures");
    }
    this.atlasTexture = atlasTexture;
    this.colorTexture = colorTexture;

    this.page = { width: this.atlasSize, height: this.atlasSize, shelves: [], nextShelfY: 0 };
    this.colorPage = {
      width: this.colorAtlasSize,
      height: this.colorAtlasSize,
      shelves: [],
      nextShelfY: 0,
    };

    this.canvas = createCanvas(1, 1);
    this.colorCanvas = createCanvas(1, 1);
    const ctx = this.canvas.getContext("2d");
    const colorCtx = this.colorCanvas.getContext("2d");
    if (!ctx || !colorCtx) {
      throw new Error("Failed to get 2D context for glyph atlas");
    }
    this.ctx = ctx;
    this.colorCtx = colorCtx;

    this.initTextures();
    this.prewarmAscii();
  }

  get texture(): WebGLTexture {
    return this.atlasTexture;
  }

  get colorAtlas(): WebGLTexture {
    return this.colorTexture;
  }

  get size(): number {
    return this.atlasSize;
  }

  get colorSize(): number {
    return this.colorAtlasSize;
  }

  reset(fontSize: number, fontFamily: string, dpr: number): void {
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.dpr = dpr;
    this.resetPages();
    this.glyphs.clear();
    this.useCounter = 0;
    this.recreateTextures();
    this.prewarmAscii();
  }

  getGlyph(grapheme: string, bold: boolean, italic: boolean): GlyphMetrics {
    if (!grapheme) {
      return emptyMetrics(false);
    }
    const isColor = isEmoji(grapheme);
    const pinned = isPinnedAscii(grapheme);
    const request: GlyphRequest = { grapheme, bold, italic, isColor, pinned };
    const key = this.makeKey(request);
    const existing = this.glyphs.get(key);
    if (existing) {
      existing.lastUsed = ++this.useCounter;
      return existing;
    }

    const created = this.addGlyph(request);
    if (created) return created;

    this.rebuildAtlas(request);
    const retry = this.addGlyph(request);
    if (retry) return retry;

    const fallback = this.createPlaceholder(request);
    this.glyphs.set(key, fallback);
    return fallback;
  }

  private initTextures(): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, this.atlasSize, this.atlasSize);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.colorAtlasSize, this.colorAtlasSize);
  }

  private prewarmAscii(): void {
    for (let code = ASCII_START; code <= ASCII_END; code++) {
      const char = String.fromCharCode(code);
      const baseRequest: Omit<GlyphRequest, "bold" | "italic" | "isColor"> = {
        grapheme: char,
        pinned: true,
      };
      this.addGlyph({ ...baseRequest, bold: false, italic: false, isColor: false });
      this.addGlyph({ ...baseRequest, bold: true, italic: false, isColor: false });
      this.addGlyph({ ...baseRequest, bold: false, italic: true, isColor: false });
    }
  }

  private addGlyph(request: GlyphRequest, lastUsed?: number): GlyphEntry | null {
    const metrics = this.tryRasterizeGlyph(request);
    if (!metrics) return null;
    const key = this.makeKey(request);
    const entry: GlyphEntry = {
      ...metrics,
      key,
      grapheme: request.grapheme,
      bold: request.bold,
      italic: request.italic,
      isColor: request.isColor,
      pinned: request.pinned,
      lastUsed: lastUsed ?? ++this.useCounter,
    };
    if (lastUsed !== undefined && lastUsed > this.useCounter) {
      this.useCounter = lastUsed;
    }
    this.glyphs.set(key, entry);
    return entry;
  }

  private tryRasterizeGlyph(request: GlyphRequest): GlyphMetrics | null {
    const { grapheme, bold, italic, isColor } = request;
    const ctx = isColor ? this.colorCtx : this.ctx;
    const canvas = isColor ? this.colorCanvas : this.canvas;

    const fontSizePx = this.fontSize * this.dpr;
    const style = `${italic ? "italic " : ""}${bold ? "bold " : ""}${fontSizePx}px ${
      this.fontFamily
    }`;
    ctx.font = style;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    const metrics = ctx.measureText(grapheme);
    const left = metrics.actualBoundingBoxLeft ?? 0;
    const right = metrics.actualBoundingBoxRight ?? metrics.width;
    const ascent = metrics.actualBoundingBoxAscent ?? fontSizePx * 0.8;
    const descent = metrics.actualBoundingBoxDescent ?? fontSizePx * 0.2;
    const width = Math.ceil(left + right);
    const height = Math.ceil(ascent + descent);

    if (width === 0 || height === 0) {
      return emptyMetrics(isColor);
    }

    const paddedW = width + PADDING * 2;
    const paddedH = height + PADDING * 2;

    const page = isColor ? this.colorPage : this.page;
    const alloc = allocateRect(page, paddedW, paddedH);
    if (!alloc) {
      return null;
    }

    canvas.width = paddedW;
    canvas.height = paddedH;
    ctx.clearRect(0, 0, paddedW, paddedH);
    ctx.font = style;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";

    const bearingX = -left;
    const bearingY = ascent;
    const drawX = PADDING + bearingX;
    const drawY = PADDING + bearingY;
    ctx.fillText(grapheme, drawX, drawY);

    const imageData = ctx.getImageData(0, 0, paddedW, paddedH);
    const gl = this.gl;

    if (isColor) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        alloc.x,
        alloc.y,
        paddedW,
        paddedH,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        imageData.data,
      );
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    } else {
      const alpha = extractAlpha(imageData.data, paddedW, paddedH);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        alloc.x,
        alloc.y,
        paddedW,
        paddedH,
        gl.RED,
        gl.UNSIGNED_BYTE,
        alpha,
      );
    }

    return {
      atlasX: alloc.x + PADDING,
      atlasY: alloc.y + PADDING,
      atlasW: width,
      atlasH: height,
      bearingX: Math.round(bearingX),
      bearingY: Math.round(bearingY),
      width,
      height,
      isColor,
    };
  }

  private rebuildAtlas(priority?: GlyphRequest): void {
    const previousEntries = Array.from(this.glyphs.values());
    const nonPinned = previousEntries
      .filter((entry) => !entry.pinned)
      .sort((a, b) => b.lastUsed - a.lastUsed);
    const priorityKey = priority ? this.makeKey(priority) : null;

    this.resetPages();
    this.recreateTextures();
    this.glyphs.clear();
    this.prewarmAscii();

    if (priority && !priority.pinned) {
      this.addGlyph(priority);
    }

    for (const entry of nonPinned) {
      if (priorityKey && entry.key === priorityKey) continue;
      if (this.glyphs.has(entry.key)) continue;
      const request: GlyphRequest = {
        grapheme: entry.grapheme,
        bold: entry.bold,
        italic: entry.italic,
        isColor: entry.isColor,
        pinned: entry.pinned,
      };
      const added = this.addGlyph(request, entry.lastUsed);
      if (!added) break;
    }
  }

  private createPlaceholder(request: GlyphRequest): GlyphEntry {
    return {
      ...emptyMetrics(request.isColor),
      key: this.makeKey(request),
      grapheme: request.grapheme,
      bold: request.bold,
      italic: request.italic,
      isColor: request.isColor,
      pinned: request.pinned,
      lastUsed: ++this.useCounter,
    };
  }

  private resetPages(): void {
    this.page = { width: this.atlasSize, height: this.atlasSize, shelves: [], nextShelfY: 0 };
    this.colorPage = {
      width: this.colorAtlasSize,
      height: this.colorAtlasSize,
      shelves: [],
      nextShelfY: 0,
    };
  }

  private recreateTextures(): void {
    this.gl.deleteTexture(this.atlasTexture);
    this.gl.deleteTexture(this.colorTexture);
    const atlasTexture = this.gl.createTexture();
    const colorTexture = this.gl.createTexture();
    if (!atlasTexture || !colorTexture) {
      throw new Error("Failed to recreate glyph atlas textures");
    }
    this.atlasTexture = atlasTexture;
    this.colorTexture = colorTexture;
    this.initTextures();
  }

  private makeKey(request: GlyphRequest): string {
    return `${request.grapheme}|${request.bold ? "b" : ""}${request.italic ? "i" : ""}|${
      request.isColor ? "c" : "m"
    }|${this.dpr}`;
  }
}

function allocateRect(
  page: AtlasPage,
  width: number,
  height: number,
): { x: number; y: number } | null {
  for (const shelf of page.shelves) {
    if (shelf.height >= height && page.width - shelf.nextX >= width) {
      const x = shelf.nextX;
      shelf.nextX += width;
      return { x, y: shelf.y };
    }
  }
  if (page.nextShelfY + height <= page.height) {
    const shelf = { y: page.nextShelfY, height, nextX: width };
    page.shelves.push(shelf);
    page.nextShelfY += height;
    return { x: 0, y: shelf.y };
  }
  return null;
}

function extractAlpha(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    out[j] = data[i + 3];
  }
  return out;
}

function emptyMetrics(isColor: boolean): GlyphMetrics {
  return {
    atlasX: 0,
    atlasY: 0,
    atlasW: 0,
    atlasH: 0,
    bearingX: 0,
    bearingY: 0,
    width: 0,
    height: 0,
    isColor,
  };
}

function isPinnedAscii(grapheme: string): boolean {
  if (grapheme.length !== 1) return false;
  const code = grapheme.codePointAt(0);
  return code !== undefined && code >= ASCII_START && code <= ASCII_END;
}

function isEmoji(grapheme: string): boolean {
  try {
    // eslint-disable-next-line no-control-regex
    return /\p{Extended_Pictographic}/u.test(grapheme);
  } catch {
    const codepoint = grapheme.codePointAt(0) ?? 0;
    return (
      (codepoint >= 0x1f300 && codepoint <= 0x1faff) || (codepoint >= 0x2600 && codepoint <= 0x27bf)
    );
  }
}

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== "undefined" && document.createElement) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error("No canvas implementation available for glyph atlas");
}
