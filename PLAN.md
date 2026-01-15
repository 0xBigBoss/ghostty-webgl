# WebGL2 Renderer Implementation Plan

## Goal

Replace Canvas2D rendering in ghostty-web with WebGL2 for 50-100% throughput improvement (23 → 35-45 MiB/s), approaching native ghostty performance.

## Validated Assumptions

| Finding | Evidence |
|---------|----------|
| Rendering is ~60% of ghostty-web pipeline | bootty 2x faster than vscode despite Canvas2D |
| ghostty parsing is allocation-free | Zig state machine, fixed buffers, RenderState API |
| WebGL reduces draw calls 1000x | 4,224 Canvas2D calls → 2-3 WebGL batches |
| Target ceiling is native ghostty | 45-66 MiB/s in benchmarks |

## Package Structure

```
ghostty-webgl/
├── ghostty/                      # Submodule (Zig reference)
├── packages/
│   ├── ghostty-web/              # Submodule (fork, renderer abstraction)
│   ├── libghostty-webgl/         # NEW: WebGL2 renderer package
│   │   ├── src/
│   │   │   ├── index.ts          # Public exports
│   │   │   ├── WebGLRenderer.ts  # Main renderer class
│   │   │   ├── GlyphAtlas.ts     # Texture atlas + metrics
│   │   │   ├── CellBuffer.ts     # Instance buffer management
│   │   │   ├── shaders/
│   │   │   │   ├── background.vert/frag
│   │   │   │   ├── glyph.vert/frag
│   │   │   │   └── decoration.vert/frag
│   │   │   └── types.ts          # CellInstance, GlyphMetrics
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── libghostty-vt/            # FUTURE: Extract WASM package
└── apps/
    └── demo/                     # Test harness
```

---

## Implementation Phases

### Phase 1: Renderer Contract Parity + Plumbing

**Goal:** Extend renderer interface to capture all inputs Canvas renderer depends on.

**Current Canvas renderer dependencies** (from `renderer.ts`):
- Viewport/scrollback: `viewportY`, `scrollbackProvider`
- Selection: `selectionRows`, selection range coordinates
- Hyperlinks: `hyperlinkRows`, hovered link range
- Theme: fg/bg colors, cursor color, palette
- Graphemes: `buffer.getGraphemeString(row, col)`
- Dirty tracking: `buffer.isRowDirty(y)`

**Tasks:**
1. Define extended `Renderer` interface:
   ```typescript
   interface RenderInput {
     // Viewport dimensions
     cols: number
     rows: number

     // Visible viewport cells, already composed from scrollback + screen
     // Length = cols * rows, row-major order
     // Composition rule (caller responsibility):
     //   If viewportY > 0, rows [0..viewportY-1] come from scrollback
     //   and rows [viewportY..rows-1] come from screen.
     viewportCells: GhosttyCell[]

     // Row flags bitfield for viewport rows (avoids Set allocations)
     // bit0 = dirty, bit1 = hasSelection, bit2 = hasHyperlink
     rowFlags: Uint8Array  // length = rows

     // Dirty tracking
     dirtyState: DirtyState
     // If dirtyState == DirtyState.FULL, treat all rows as dirty (ignore rowFlags)

     // Selection
     selectionRange: SelectionRange | null

     // Hyperlinks
     hoveredLink: HyperlinkRange | null

     // Cursor (viewport-relative coordinates)
     cursorX: number
     cursorY: number
     // cursorVisible must already reflect viewport visibility (false when scrolled)
     cursorVisible: boolean
     cursorStyle: CursorStyle

     // Viewport-relative grapheme lookup (caller maps scrollback/screen)
     // Returns single codepoint for simple cells; returns '' for invalid coords
     getGraphemeString(viewportRow: number, col: number): string

     // Theme
     theme: TerminalTheme
   }

   // Row flag constants
   const ROW_DIRTY = 0x01
   const ROW_HAS_SELECTION = 0x02
   const ROW_HAS_HYPERLINK = 0x04

   interface Renderer {
     attach(canvas: HTMLCanvasElement): void
     resize(cols: number, rows: number, metrics: CellMetrics): void
     render(input: RenderInput): void
     updateTheme(theme: TerminalTheme): void
     dispose(): void
   }
   ```

**RenderInput notes (parity-critical):**
- `cursorVisible` should be false when `viewportY > 0` (Canvas hides cursor while scrolled).
- Selection opacity should default to 0.4 (current Canvas behavior). If theme doesn’t expose it, add `selectionOpacity?: number` to `TerminalTheme`.
- Default background (bg = 0,0,0) should be treated as “transparent to theme background,” except when selected (still draw selection overlay).
- If `viewportY > 0`, force all rows dirty and rely on scrollback composition for `viewportCells` (matches Canvas behavior).

2. Refactor `CanvasRenderer` to accept `RenderInput`

3. Create `libghostty-webgl` package skeleton with stub implementation

**Deliverable:** Interface defined, Canvas renderer refactored, WebGL package compiles.

---

### Phase 2: WebGL Context + Background-Only Validation

**Goal:** Validate GL setup with backgrounds only (no text complexity).

**Tasks:**
1. WebGL2 context acquisition:
   - Request with `{ antialias: false, alpha: true }` (alpha configurable; default true for transparent themes)
   - Fallback detection if WebGL2 unavailable
   - Context loss event listeners

2. Coordinate system setup:
   - Grid origin at top-left
   - DPR scaling: canvas size × devicePixelRatio
   - Grid → NDC transform in vertex shader

3. Background-only instanced draw:
   - One quad per cell, scaled by cellSpan for wide characters
   - Instance data: bgRGBA + cellSpan (u8)
   - Background quad width = `cellSpan * cellWidth`
   - Skip draw when `cellSpan == 0` (continuation cell, matches Canvas behavior)
   - Treat default background as transparent: encode `bgA = 0` when default bg and not selected, then discard in fragment shader
   - Validate dirty-row `bufferSubData` updates
   - Use `rowFlags & ROW_DIRTY` to decide row uploads (unless dirtyState == FULL)

   **Background vertex shader snippet:**
   ```glsl
   // Skip continuation cells (cellSpan == 0)
   flat out float v_skip;
   v_skip = a_cellSpan == 0.0 ? 1.0 : 0.0;

   // Scale quad width by cellSpan (1 for normal, 2 for wide)
   vec2 size = u_cellSize * vec2(max(a_cellSpan, 1.0), 1.0);
   ```

   Background fragment shader should `discard` when `v_skip > 0.5` or `bgA == 0` (transparent default bg).

4. Selection overlay:
   - Pre-blend selection color into bgRGBA on CPU using selectionOpacity (default 0.4)
   - If `selectionForeground` is defined, override fgRGBA for selected cells
   - Inverse video: swap fg/bg on CPU

5. Scrollback/viewport:
   - Renderer receives pre-composed `viewportCells` (caller handles scrollback composition)
   - Validate output matches Canvas for scrolled viewports

**Deliverable:** WebGL renderer draws colored backgrounds matching Canvas output.

---

### Phase 3: Instance Buffer Architecture + Dirty Updates

**Goal:** Lock down fixed-stride buffer layout for efficient row updates.

**CellInstance Schema (32 bytes, little-endian):**

```typescript
// TypeScript type (for documentation)
interface CellInstance {
  // Atlas rect (8 bytes)
  atlasX: u16      // offset 0
  atlasY: u16      // offset 2
  atlasW: u16      // offset 4
  atlasH: u16      // offset 6

  // Glyph bearing for overflow (4 bytes)
  bearingX: i16    // offset 8
  bearingY: i16    // offset 10

  // Cell flags (4 bytes)
  cellSpan: u8     // offset 12: 0=skip, 1=normal, 2=wide
  decoFlags: u8    // offset 13: underline|strike|hyperlink
  glyphFlags: u8   // offset 14: colorAtlas|blink|reserved
  pad: u8          // offset 15

  // Foreground RGBA (4 bytes)
  fgR: u8          // offset 16
  fgG: u8          // offset 17
  fgB: u8          // offset 18
  fgA: u8          // offset 19: faint/invisible → alpha

  // Background RGBA (4 bytes)
  bgR: u8          // offset 20
  bgG: u8          // offset 21
  bgB: u8          // offset 22
  bgA: u8          // offset 23: selection pre-blended

  // Decoration color (4 bytes)
  decoR: u8        // offset 24
  decoG: u8        // offset 25
  decoB: u8        // offset 26
  decoA: u8        // offset 27

  // Reserved (4 bytes)
  reserved: u32    // offset 28: cursor flags, underline style
}

const CELL_STRIDE = 32

// Glyph flag constants
const GLYPH_COLOR_ATLAS = 0x01
```

**Buffer layout:**
- Row-major: `buffer[row * cols + col]`
- Row update: `gl.bufferSubData(target, row * cols * CELL_STRIDE, rowData)`
- Total size: `rows * cols * 32` bytes (80×24 = 61KB, 300×80 = 768KB)
- Store atlas rect/size in pixels and normalize in shader by dividing by `u_atlasSize` (avoid normalized-attribute ambiguity).
- Prefer integer vertex attributes in WebGL2 (`vertexAttribIPointer`) with `flat in uint` flags to avoid float precision issues.

**Key behaviors:**
- Wide glyphs: leading cell `cellSpan=2`, trailing `cellSpan=0` (skip draw)
- Background pass: uses `cellSpan` to scale quad width; `cellSpan=0` → discard
- Glyph pass: uses `cellSpan` to select wide glyph from atlas; `cellSpan=0` → discard
- Selection: pre-compute blend into bgRGBA; if `selectionForeground` is set, override fgRGBA
- Inverse/faint: resolve on CPU into fg/bg/fgA
- Draw all instances every frame; dirty tracking only minimizes uploads
  - If dirty rows > ~30–50%, upload full buffer to reduce `bufferSubData` overhead

**Tasks:**
1. Implement `CellBuffer` class with typed array view
2. Implement row-based dirty update with `bufferSubData`
   - Use `rowFlags & ROW_DIRTY` to identify rows needing upload
   - Use `rowFlags & ROW_HAS_SELECTION` for selection pre-blend
   - Include rows affected by hover changes (hyperlinks) when setting `rowFlags`
3. Add `cellSpan` handling in vertex shaders (skip if 0, scale width if 2)
4. Use integer vertex attributes for flags and pack `glyphFlags` as `u8`
5. Validate dirty-row updates match full-buffer updates

**Hyperlink hover change detection (caller responsibility):**
```typescript
// Track previous hover state to detect changes
let previousHoveredHyperlinkId = 0
let previousHoveredLinkRange: { startY: number; endY: number } | null = null

function computeRowFlags(input: RenderInput): void {
  const { hoveredLink, rowFlags, viewportCells, cols, rows } = input

  // Detect hyperlink hover changes (OSC8 hyperlinks)
  const hyperlinkChanged = hoveredLink?.hyperlinkId !== previousHoveredHyperlinkId

  if (hyperlinkChanged) {
    // Mark rows containing OLD hyperlink as needing redraw
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const cell = viewportCells[y * cols + x]
        if (cell.hyperlink_id === previousHoveredHyperlinkId ||
            cell.hyperlink_id === hoveredLink?.hyperlinkId) {
          rowFlags[y] |= ROW_DIRTY | ROW_HAS_HYPERLINK
          break
        }
      }
    }
    previousHoveredHyperlinkId = hoveredLink?.hyperlinkId ?? 0
  }

  // Detect regex link range changes
  const rangeChanged = !rangesEqual(hoveredLink?.range, previousHoveredLinkRange)
  if (rangeChanged) {
    // Mark rows in OLD range
    if (previousHoveredLinkRange) {
      for (let y = previousHoveredLinkRange.startY; y <= previousHoveredLinkRange.endY; y++) {
        if (y >= 0 && y < rows) rowFlags[y] |= ROW_DIRTY | ROW_HAS_HYPERLINK
      }
    }
    // Mark rows in NEW range
    if (hoveredLink?.range) {
      for (let y = hoveredLink.range.startY; y <= hoveredLink.range.endY; y++) {
        if (y >= 0 && y < rows) rowFlags[y] |= ROW_DIRTY | ROW_HAS_HYPERLINK
      }
    }
    previousHoveredLinkRange = hoveredLink?.range ?? null
  }
}
```

**Adjacent row handling for glyph overflow:**
- Complex scripts (Devanagari, Arabic) may have glyphs that extend into adjacent rows
- Canvas renderer includes y±1 when marking dirty rows
- WebGL approach: always draw all glyphs (no clipping); dirty tracking only affects uploads
- If adjacent row artifacts appear, extend `rowFlags` marking to include y-1, y+1 for dirty rows

**Deliverable:** Buffer architecture locked, row updates validated.

---

### Phase 4: Glyph Atlas + Metrics

**Goal:** Build atlas with grapheme keys and glyph metrics for overflow.

**Atlas key:** `(graphemeString, bold, italic, dpr)`

**GlyphMetrics:**
```typescript
interface GlyphMetrics {
  // Position in atlas texture
  atlasX: number
  atlasY: number
  atlasW: number
  atlasH: number

  // Bearing relative to cell origin/baseline (for overflow)
  bearingX: number  // left side bearing from cell origin (pixels, signed)
  bearingY: number  // distance from baseline to glyph top (pixels, signed)

  // Actual glyph dimensions
  width: number
  height: number
}
```

**Tasks:**
1. Create `GlyphAtlas` class:
   - Offscreen canvas for rasterization
   - 2D bin-packing for glyph placement
   - Measure bearing via canvas `measureText()` + manual baseline calc
   - Define bearing convention explicitly and keep shader math consistent (baseline + sign)
   - Validate bearing math against Canvas `fillText` for a small glyph set

**Bearing convention (critical for overflow glyphs):**
```typescript
// Canvas measureText returns:
// - actualBoundingBoxLeft: distance from alignment point LEFT to left edge (positive = extends left)
// - actualBoundingBoxAscent: distance from baseline UP to top edge (positive = above baseline)

// Convert to our convention:
interface GlyphBearing {
  bearingX: number  // Pixels from cell left edge to glyph left edge (positive = shift right)
  bearingY: number  // Pixels from baseline to glyph TOP (positive = above baseline)
}

function measureGlyph(ctx: CanvasRenderingContext2D, char: string): GlyphBearing {
  const metrics = ctx.measureText(char)

  // bearingX: negative actualBoundingBoxLeft means glyph starts LEFT of origin
  // We want: positive = glyph starts to the right of cell origin
  const bearingX = -metrics.actualBoundingBoxLeft

  // bearingY: actualBoundingBoxAscent is distance from baseline UP
  // We store this directly (positive = glyph top is above baseline)
  const bearingY = metrics.actualBoundingBoxAscent

  return { bearingX, bearingY }
}

// Shader usage (vertex):
// glyphTopLeft = cellOrigin + vec2(0, baseline) + vec2(bearingX, -bearingY)
// Note: Y is negated because screen Y increases downward
```

**Validation set for bearing math:**
- `M` - standard baseline character
- `g` - descender below baseline
- `ि` (Devanagari vowel sign I) - extends LEFT of origin
- `ై` (Telugu vowel sign AI) - extends above baseline
- `🎉` - emoji (wide, no bearing issues)
- Verify each renders identically to Canvas `fillText`

2. ASCII prewarm:
   - Pre-render chars 32-126 on init (normal, bold, italic variants)
   - Direct lookup: `atlas.get(char)` → O(1)

3. LRU cache for extended glyphs:
   - Key by grapheme string (handles combining marks)
   - Evict when atlas full, re-rasterize on demand

**Atlas packing strategy (shelf algorithm recommended):**
- **Shelf packing**: Best compromise for glyphs - simple, efficient, fast
- Separate 2D allocation into vertical shelf management + horizontal item placement
- Add 1px padding on all sides (avoid sampling bleed if filtering changes)
- xterm.js uses multiple active rows, selecting based on glyph pixel height
- Slab allocator (fixed power-of-two slots) wastes >50% space for non-square glyphs
- Alternative: 2D texture array with 1×32 glyph grid per layer (beamterm approach)

```typescript
// Simple shelf packing sketch
interface Shelf {
  y: number
  height: number
  nextX: number
}

function allocateGlyph(width: number, height: number): { x: number; y: number } | null {
  // Find best-fit shelf (closest height match)
  const shelf = shelves.find(s => s.height >= height && atlasWidth - s.nextX >= width)
  if (shelf) {
    const x = shelf.nextX
    shelf.nextX += width
    return { x, y: shelf.y }
  }
  // Create new shelf if space available
  if (nextShelfY + height <= atlasHeight) {
    const newShelf = { y: nextShelfY, height, nextX: width }
    shelves.push(newShelf)
    nextShelfY += height
    return { x: 0, y: newShelf.y }
  }
  return null  // Atlas full, trigger LRU eviction or resize
}
```

4. Separate RGBA atlas for color emoji:
   - Detect emoji ranges, route to color atlas
   - Separate texture unit in shader
   - Add `GLYPH_COLOR_ATLAS` flag in `glyphFlags`
   - Use premultiplied alpha for emoji uploads (`UNPACK_PREMULTIPLY_ALPHA_WEBGL = true`, then reset to false)

5. Re-rasterize on DPR/font changes:
   - Listen for `matchMedia('resolution')` changes
   - Clear atlas and rebuild
   - Safari fallback: if `OffscreenCanvas` or `actualBoundingBox*` unavailable, use in-DOM canvas + conservative metrics

**Deliverable:** Atlas renders glyphs with correct metrics, handles graphemes.

---

### Phase 5: Text Pass with Overflow-Safe Quads

**Goal:** Render glyphs that can extend outside cell bounds.

**Two-pass rendering:**
1. **Background pass:** Cell-aligned quads, bgRGBA
2. **Text pass:** Glyph-sized quads using bearing/size, fgRGBA

**Vertex shader (glyph pass):**
```glsl
#version 300 es
precision highp float;

// Per-vertex (quad corners)
in vec2 a_position;  // 0,0 to 1,1

// Per-instance (from CellInstance buffer)
in vec2 a_atlasRect;   // atlasX, atlasY (pixels)
in vec2 a_atlasSize;   // atlasW, atlasH (pixels)
in vec2 a_bearing;     // bearingX, bearingY (pixels)
in float a_cellSpan;   // 0=skip, 1=normal, 2=wide
in float a_glyphFlags; // bitfield (GLYPH_COLOR_ATLAS, ...)
in vec4 a_fgColor;     // fgRGBA

// Uniforms
uniform vec2 u_cellSize;    // cell dimensions in pixels
uniform vec2 u_gridSize;    // terminal cols, rows
uniform vec2 u_atlasSize;   // atlas texture dimensions (pixels)
uniform float u_baseline;   // baseline offset from cell top (pixels)

out vec2 v_texCoord;
out vec4 v_fgColor;
flat out float v_skip;
flat out float v_colorAtlas;

void main() {
  // Skip if cellSpan == 0 (wide char continuation)
  v_skip = a_cellSpan == 0.0 ? 1.0 : 0.0;

  // Compute cell position from gl_InstanceID
  int col = gl_InstanceID % int(u_gridSize.x);
  int row = gl_InstanceID / int(u_gridSize.x);

  // Cell origin in pixels (top-left)
  vec2 cellOrigin = vec2(float(col), float(row)) * u_cellSize;

  // Glyph quad position using bearing + baseline
  vec2 glyphSize = a_atlasSize;
  vec2 baselineOrigin = cellOrigin + vec2(0.0, u_baseline);
  vec2 glyphPos = baselineOrigin + vec2(a_bearing.x, -a_bearing.y) + a_position * glyphSize;

  // Convert to NDC (assuming viewport matches canvas)
  vec2 canvasSize = u_gridSize * u_cellSize;
  vec2 ndc = (glyphPos / canvasSize) * 2.0 - 1.0;
  ndc.y = -ndc.y;  // Flip Y for top-left origin

  gl_Position = vec4(ndc, 0.0, 1.0);

  // Texture coordinates
  v_texCoord = (a_atlasRect + a_position * a_atlasSize) / u_atlasSize;
  v_fgColor = a_fgColor;
  v_colorAtlas = mod(a_glyphFlags, 2.0); // GLYPH_COLOR_ATLAS = bit 0
}
```

**Fragment shader (glyph pass):**
```glsl
#version 300 es
precision highp float;

uniform sampler2D u_atlas;
uniform sampler2D u_colorAtlas;

in vec2 v_texCoord;
in vec4 v_fgColor;
flat in float v_skip;
flat in float v_colorAtlas;

out vec4 fragColor;

void main() {
  if (v_skip > 0.5) discard;

  if (v_colorAtlas > 0.5) {
    vec4 rgba = texture(u_colorAtlas, v_texCoord);
    float outA = rgba.a * v_fgColor.a;
    fragColor = vec4(rgba.rgb * v_fgColor.a, outA);
  } else {
    float coverage = texture(u_atlas, v_texCoord).r;
    float outA = v_fgColor.a * coverage;
    fragColor = vec4(v_fgColor.rgb * outA, outA);
  }
}
```

**Tasks:**
1. Implement background pass (cell-aligned quads)
2. Implement glyph pass (bearing-offset quads)
3. Validate glyph overflow renders correctly
4. Handle wide glyphs (`cellSpan=2` uses double-width atlas entry)
5. Use premultiplied-alpha blending globally: `gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)`

**Premultiplied alpha blending (critical for correct compositing):**
With `premultipliedAlpha: true` (default), the browser expects premultiplied output. Using the wrong blend function causes washed-out colors.

```typescript
// CORRECT: Premultiplied alpha (WebGL default compositing)
gl.enable(gl.BLEND)
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
// Formula: src + dst * (1 - srcA)

// WRONG: Non-premultiplied (causes artifacts with WebGL compositing)
// gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
// Formula: src * srcA + dst * (1 - srcA)

// For glyph atlas: output must be premultiplied
// float outA = fgColor.a * alpha
// fragColor = vec4(fgColor.rgb * outA, outA)  // Premultiply in shader
// OR upload with UNPACK_PREMULTIPLY_ALPHA_WEBGL = true
```

**Context `alpha` option:**
Avoid `alpha: false` - it causes performance cost on some platforms (RGB backbuffer emulated on RGBA).
Instead, use `alpha: true` and write `1.0` to alpha channel where transparency isn't needed.

**Deliverable:** Text renders with correct overflow, no clipping.

---

### Phase 6: Decorations + Cursor Parity

**Goal:** Complete visual parity with Canvas renderer.

**Decorations (via decoFlags):**
- `UNDERLINE = 0x01`
- `STRIKETHROUGH = 0x02`
- `HYPERLINK = 0x04`
- `CURLY_UNDERLINE = 0x08`

**Options:**
- **Option A:** Third draw pass for decoration lines
- **Option B:** Decoration geometry in fragment shader using SDF

**Cursor rendering:**
- Block: filled quad at cursor position
- Underline: thin rect at cell bottom
- Bar: thin rect at cell left
- Blink: uniform toggle or CSS animation on canvas

**Tasks:**
1. Implement decoration pass or fragment shader branch
2. Implement cursor rendering with style variants
3. Validate selection foreground rules match Canvas
4. Test hyperlink underline on hover

**Deliverable:** Full visual parity with CanvasRenderer.

---

### Phase 7: Context Loss, Fallback, and Benchmarks

**Goal:** Production-ready robustness and validation.

**Context loss handling:**
1. `webglcontextlost`: Prevent default, mark renderer invalid
2. `webglcontextrestored`: Rebuild all GL resources, re-upload atlas
3. Fallback to Canvas after N consecutive failures

**Fallback strategy:**
- WebGL unavailable → use CanvasRenderer
- Context loss unrecoverable → switch to CanvasRenderer
- No per-row fallback (not feasible without dual-canvas)

**Benchmarks:**
- Throughput: MiB/s via existing benchmark suite
- Frame time: `performance.now()` around render calls
- Memory: atlas texture size + instance buffer size
- Targets: Chrome, Firefox, Safari, VS Code webview

**Browser guardrails (WebKit/Safari):**
- Validate `OffscreenCanvas` availability; fallback to in-DOM canvas for atlas rasterization.
- Use `R8`/`RED` or `RGBA` explicitly for glyph atlas (avoid legacy `ALPHA` formats).
- Ensure integer attributes use `vertexAttribIPointer` + `flat in uint` (avoid float conversion).

**Tasks:**
1. Implement context loss handlers
2. Add renderer auto-detection and fallback
3. Run benchmark suite, compare to Canvas baseline
4. Document results and any regressions

**Deliverable:** Production-ready WebGL renderer shipping in vscode-bootty.

---

### Cross-Platform WebGL2 Best Practices

**Texture configuration (critical for Safari):**
```typescript
// Pixel store settings - set BEFORE texImage2D/texSubImage2D
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)           // Glyph atlas rows may not be 4-byte aligned
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)    // Canvas origin matches WebGL (top-left)
gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE) // Avoid implicit sRGB conversions
gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)          // Reset in case other code touched it
gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)  // For color emoji atlas only (reset to false for glyphs)

// Validate max texture size before atlas allocation
const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE)  // Typically 4096-16384
if (atlasSize > maxSize) {
  // Use multiple smaller atlases or reduce glyph cache
}
```

**Texture parameters (atlas):**
```typescript
// Default MIN_FILTER expects mipmaps; set explicitly for single-level atlases.
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST) // No mipmaps
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
```

**Anti-aliasing:**
- Prefer `antialias: false` for the WebGL context; MSAA does not improve text atlas quality and adds cost.
- If enabling MSAA for other reasons, measure and keep blending in premultiplied mode.

**Texture format selection:**
| Atlas Type | Internal Format | Format | Type | Notes |
|------------|----------------|--------|------|-------|
| Glyph (grayscale) | `R8` | `RED` | `UNSIGNED_BYTE` | WebGL2 standard; Safari OK |
| Color emoji | `RGBA8` | `RGBA` | `UNSIGNED_BYTE` | Premultiplied alpha |
| Fallback (WebGL1 compat) | `LUMINANCE` | `LUMINANCE` | `UNSIGNED_BYTE` | Avoid; prefer R8 |

**Important:** Prefer `RGBA8`; `RGB8` can be slower or emulated on some drivers.
**Note:** For `R8` atlas sampling, read `.r` in shader (or set a swizzle to map `R→A`).

**Use `texStorage2D` for atlas allocation:**
```typescript
// Preferred: immutable storage, predictable memory, avoids accidental mipmap issues
gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, atlasWidth, atlasHeight)
gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RED, gl.UNSIGNED_BYTE, glyphData)

// texImage2D is valid but can realloc if size changes; keep sizes stable if using it
// gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data)
```

**Color space handling (sRGB):**
- Default drawing buffer color space is `srgb` in modern browsers; query `gl.drawingBufferColorSpace` where supported.
- WebGL does not expose `FRAMEBUFFER_SRGB` toggling; if exact matching is needed, do manual gamma conversion.
- For MVP: skip gamma correction; visual difference is minor for terminal colors.

**Buffer streaming for dirty row updates:**
```typescript
// Option 1: bufferSubData (simple, works everywhere)
gl.bufferSubData(gl.ARRAY_BUFFER, rowOffset, rowData)

// Option 2: Buffer orphaning (better for frequent partial updates)
// Re-allocate buffer with null, then subdata - avoids GPU stall
if (dirtyRowCount > rows * 0.5) {
  gl.bufferData(gl.ARRAY_BUFFER, fullBuffer, gl.DYNAMIC_DRAW)
} else {
  gl.bufferSubData(gl.ARRAY_BUFFER, rowOffset, rowData)
}

// Threshold: if >50% rows dirty, upload full buffer (fewer driver calls)
```

**Integer vertex attributes (WebGL2):**
```glsl
// Vertex shader: use flat integers for flags
// Use highp for 32-bit bitfields; mediump/lowp ranges are too small per GLSL ES
layout(location = 3) in highp uint a_flags;  // cellSpan | decoFlags | glyphFlags packed
flat out highp uint v_flags;

void main() {
  uint cellSpan = a_flags & 0xFFu;
  uint decoFlags = (a_flags >> 8u) & 0xFFu;
  // ...
}
```
```typescript
// JavaScript: use vertexAttribIPointer for integers (not vertexAttribPointer)
gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, stride, offset)
gl.enableVertexAttribArray(3)
gl.vertexAttribDivisor(3, 1)  // Per-instance
```

**VAO usage (WebGL2):**
- Create one VAO per pipeline (background pass, text pass).
- Bind quad VBO + instance buffer attributes once during setup.
- On each frame, only update buffers; avoid re-specifying attribute pointers.
- Re-create VAOs after context loss (they are not restored).

**Uniform buffers (optional):**
- For small uniform sets (cell size, grid size, atlas size), plain `uniform` calls are fine.
- Consider UBOs if sharing the same uniforms across multiple programs or if updates become frequent.

**Mobile precision requirements (iOS/Safari/Android):**
- `highp int` required for 32-bit bitfields; `mediump`/`lowp` int ranges are too small for packed flags.
- Declare `precision highp float;` in fragment shaders when doing pixel math or large coordinate math.
- Consider `gl.getShaderPrecisionFormat()` in a dev check to assert expected ranges.

**Context loss recovery checklist:**
1. `webglcontextlost`: `event.preventDefault()`, set `contextValid = false`, cancel animation frames
2. `webglcontextrestored`:
   - Re-create all WebGL resources (programs, buffers, textures, VAOs)
   - Re-upload glyph atlas from cached Canvas data
   - Re-upload instance buffer (full buffer)
   - Set `contextValid = true`, trigger full redraw
3. Track consecutive failures; after 3, fallback permanently to Canvas
4. Check `gl.isContextLost()` in error handlers to avoid false shader compile errors

```typescript
// Context loss handling pattern
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault()  // Required to allow restore
  contextValid = false
  if (animationFrameId) cancelAnimationFrame(animationFrameId)
})

canvas.addEventListener('webglcontextrestored', () => {
  initWebGL()        // Re-create programs, VAOs, buffers
  rebuildAtlas()     // Re-upload glyph textures
  contextValid = true
  requestRender()    // Trigger full redraw
})

// In error handling
if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
  if (gl.isContextLost()) return  // Don't log errors during context loss
  console.error(gl.getShaderInfoLog(shader))
}
```

---

### Validation Test Harness

**Pixel-diff regression tests:**
```typescript
// Test harness structure
interface RenderTestCase {
  name: string
  input: RenderInput
  expectedCanvas: HTMLCanvasElement  // Reference from CanvasRenderer
}

async function validateParity(webgl: WebGLRenderer, canvas: CanvasRenderer, testCase: RenderTestCase) {
  // Render both
  webgl.render(testCase.input)
  canvas.render(testCase.input)

  // Extract pixels
  const webglPixels = getCanvasPixels(webgl.canvas)
  const canvasPixels = getCanvasPixels(canvas.canvas)

  // Compare with tolerance (anti-aliasing may differ slightly)
  const diff = pixelDiff(webglPixels, canvasPixels, { threshold: 0.1 })
  assert(diff.percentDifferent < 0.5, `${testCase.name}: ${diff.percentDifferent}% pixels differ`)
}

// Critical test cases:
const PARITY_TESTS: RenderTestCase[] = [
  { name: 'selection-opacity', /* ... */ },        // Selection with 0.4 opacity
  { name: 'inverse-video', /* ... */ },            // INVERSE flag
  { name: 'wide-chars', /* ... */ },               // CJK characters (cellSpan=2)
  { name: 'emoji-color', /* ... */ },              // Color emoji rendering
  { name: 'devanagari-overflow', /* ... */ },      // Glyphs extending left
  { name: 'scrolled-cursor-hidden', /* ... */ },   // Cursor hidden when scrolled
  { name: 'default-bg-transparent', /* ... */ },   // Theme background shows through
  { name: 'hyperlink-underline', /* ... */ },      // Blue underline on hover
]
```

**Safari smoke test checklist:**
- [ ] Context acquisition succeeds (`canvas.getContext('webgl2')` not null)
- [ ] R8 texture format works (glyph atlas renders)
- [ ] Integer vertex attributes work (`vertexAttribIPointer`)
- [ ] Premultiplied alpha blending correct (emoji not washed out)
- [ ] OffscreenCanvas fallback works (or in-DOM canvas used)
- [ ] No console warnings about deprecated features
- [ ] Performance: 60fps on 80×24 terminal
- [ ] Context loss recovery works (simulate via WebGL Inspector)

**Performance guardrails:**
```typescript
// Track frame time and warn on regression
const FRAME_BUDGET_MS = 16.67  // 60fps
const frameStart = performance.now()
renderer.render(input)
const frameTime = performance.now() - frameStart

if (frameTime > FRAME_BUDGET_MS * 2) {
  console.warn(`Frame took ${frameTime.toFixed(1)}ms (budget: ${FRAME_BUDGET_MS}ms)`)
}

// Track dirty row upload efficiency
const uploadStart = performance.now()
cellBuffer.updateDirtyRows(rowFlags)
const uploadTime = performance.now() - uploadStart

// If upload takes >2ms, consider full buffer strategy
if (uploadTime > 2 && dirtyRowCount < rows * 0.5) {
  console.debug('Consider full buffer upload for better perf')
}
```

---

## Decisions on Open Questions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Sub-pixel rendering | Skip for MVP | Requires RGB glyph textures + careful blending; high risk |
| Emoji | Separate RGBA atlas | Alpha-only loses color; separate texture unit |
| Ligatures | Disabled by default | Per-cell model doesn't support cross-cell shaping |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| WebGL unavailable | Auto-fallback to CanvasRenderer |
| Context loss | Event handlers + rebuild; fallback after N failures |
| Glyph atlas overflow | LRU eviction + atlas resize |
| Complex scripts (Arabic, Devanagari) | Grapheme-keyed atlas handles shaping; bearing handles overflow |
| Per-row Canvas fallback | Not supported; full fallback only |

---

## Success Metrics

| Metric | Current (Canvas2D) | Target (WebGL2) |
|--------|-------------------|-----------------|
| Throughput | 23 MiB/s | 35-45 MiB/s |
| Draw calls/frame | ~4,224 | 2-3 |
| Large terminal (300×80) | Laggy | Smooth 60fps |
| Memory overhead | Baseline | +2-8MB (atlas + buffer) |

---

## References

### Implementation References
- [xterm.js addon-webgl](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl) - Production WebGL2 terminal renderer
- [beamterm](https://github.com/junkdog/beamterm) - Project with published performance targets (sub-ms @ ~45k cells)
- [VS Code WebGL PR #84440](https://github.com/microsoft/vscode/pull/84440) - Performance measurements vs Canvas renderer
- ghostty-web Canvas renderer: `packages/ghostty-web/lib/renderer.ts`
- ghostty RenderState API: `packages/ghostty-web/lib/ghostty.ts`

### WebGL2 Best Practices
- [MDN WebGL Best Practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices) - Texture formats, buffer updates, iOS precision
- [WebGL and Alpha](https://webglfundamentals.org/webgl/lessons/webgl-and-alpha.html) - Premultiplied alpha blending
- [WebGL Instanced Drawing](https://webglfundamentals.org/webgl/lessons/webgl-instanced-drawing.html) - Instancing fundamentals
- [Khronos Context Loss Wiki](https://www.khronos.org/webgl/wiki/HandlingContextLost) - Context loss handling
- [MDN drawingBufferColorSpace](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawingBufferColorSpace) - Canvas color space handling
- [MDN unpackColorSpace](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/unpackColorSpace) - Upload color space conversion
- [GLSL ES 3.00 Spec §4.5.2](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf) - Precision qualifiers and ranges

### Texture Atlas & Text Rendering
- [WebRender Texture Atlas (etagere)](https://nical.github.io/posts/etagere.html) - Shelf packing algorithm analysis
- [WebGL Text with Glyph Textures](https://webglfundamentals.org/webgl/lessons/webgl-text-glyphs.html) - Glyph atlas fundamentals
- [Warp Glyph Atlases](https://www.warp.dev/blog/adventures-text-rendering-kerning-glyph-atlases) - Production terminal atlas strategy

### Browser Compatibility
- [WebGL2 Browser Support](https://caniuse.com/webgl2) - Current support matrix
- [Cesium iOS 18.2/18.3 context loss reports](https://community.cesium.com/t/crashing-on-ios-18-2-and-18-3-on-specific-devices/39615) - iPad 9th gen + older devices (Mar 31, 2025)

---

## Appendix: Benchmark Data

**VS Code WebGL PR #84440 Results:**

| Platform | Terminal Size | Speedup vs Canvas2D |
|----------|---------------|---------------------|
| Windows | 87×26 | 901% |
| Windows | 300×80 | 839% |
| macOS | 300×80 | 314% |

**Related Repositories:**

| Repo | Purpose |
|------|---------|
| `0xBigBoss/ghostty` | Zig source fork (WASM build reference) |
| `0xBigBoss/ghostty-web` | ghostty-web fork (Canvas2D renderer) |
| `0xBigBoss/vscode-bootty` | VS Code extension (consumer) |

**ghostty-web Exports (reference):**
- `Terminal` - Main terminal class (xterm.js API compatible)
- `Ghostty` - WASM wrapper for ghostty-vt runtime
- `CanvasRenderer` - Canvas2D renderer (to be abstracted)
- `KeyEncoder` - Keyboard → escape sequences
- `FitAddon` - Auto-resize terminal to container
- `SelectionManager`, `LinkDetector`, `InputHandler`
