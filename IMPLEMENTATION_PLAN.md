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
     // Viewport
     cols: number
     rows: number
     viewportY: number

     // Cell data (from RenderState.getViewport())
     cells: GhosttyCell[]

     // Dirty tracking
     dirtyState: DirtyState
     isRowDirty(row: number): boolean

     // Selection
     selectionRange: SelectionRange | null
     selectionRows: Set<number>

     // Hyperlinks
     hoveredLink: HyperlinkRange | null
     hyperlinkRows: Set<number>

     // Cursor
     cursorX: number
     cursorY: number
     cursorVisible: boolean
     cursorStyle: CursorStyle

     // Grapheme access (for complex clusters)
     getGraphemeString(row: number, col: number): string

     // Theme
     theme: TerminalTheme
   }

   interface Renderer {
     attach(canvas: HTMLCanvasElement): void
     resize(cols: number, rows: number, metrics: CellMetrics): void
     render(input: RenderInput): void
     updateTheme(theme: TerminalTheme): void
     dispose(): void
   }
   ```

2. Refactor `CanvasRenderer` to accept `RenderInput`

3. Create `libghostty-webgl` package skeleton with stub implementation

**Deliverable:** Interface defined, Canvas renderer refactored, WebGL package compiles.

---

### Phase 2: WebGL Context + Background-Only Validation

**Goal:** Validate GL setup with backgrounds only (no text complexity).

**Tasks:**
1. WebGL2 context acquisition:
   - Request with `{ antialias: false, alpha: false }`
   - Fallback detection if WebGL2 unavailable
   - Context loss event listeners

2. Coordinate system setup:
   - Grid origin at top-left
   - DPR scaling: canvas size × devicePixelRatio
   - Grid → NDC transform in vertex shader

3. Background-only instanced draw:
   - One quad per cell
   - Instance data: just bgRGBA for now
   - Validate dirty-row `bufferSubData` updates

4. Selection overlay:
   - Pre-blend selection color into bgRGBA on CPU
   - Inverse video: swap fg/bg on CPU

5. Scrollback/viewport:
   - Use `viewportY` to offset into scrollback
   - Validate composition matches Canvas

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
  glyphFlags: u8   // offset 14: blink|reserved
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
```

**Buffer layout:**
- Row-major: `buffer[row * cols + col]`
- Row update: `gl.bufferSubData(target, row * cols * CELL_STRIDE, rowData)`
- Total size: `rows * cols * 32` bytes (80×24 = 61KB, 300×80 = 768KB)

**Key behaviors:**
- Wide glyphs: leading cell `cellSpan=2`, trailing `cellSpan=0` (skip draw)
- Selection: pre-compute blend into bgRGBA
- Inverse/faint: resolve on CPU into fg/bg/fgA
- Draw all instances every frame; dirty tracking only minimizes uploads

**Tasks:**
1. Implement `CellBuffer` class with typed array view
2. Implement row-based dirty update with `bufferSubData`
3. Add `cellSpan` handling in vertex shader (skip if 0)
4. Validate dirty-row updates match full-buffer updates

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

  // Bearing relative to cell origin (for overflow)
  bearingX: number  // left edge offset from cell left
  bearingY: number  // top edge offset from cell baseline

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

2. ASCII prewarm:
   - Pre-render chars 32-126 on init (normal, bold, italic variants)
   - Direct lookup: `atlas.get(char)` → O(1)

3. LRU cache for extended glyphs:
   - Key by grapheme string (handles combining marks)
   - Evict when atlas full, re-rasterize on demand

4. Separate RGBA atlas for color emoji:
   - Detect emoji ranges, route to color atlas
   - Separate texture unit in shader

5. Re-rasterize on DPR/font changes:
   - Listen for `matchMedia('resolution')` changes
   - Clear atlas and rebuild

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
in vec2 a_atlasRect;   // atlasX, atlasY (normalized)
in vec2 a_atlasSize;   // atlasW, atlasH (normalized)
in vec2 a_bearing;     // bearingX, bearingY (pixels)
in float a_cellSpan;   // 0=skip, 1=normal, 2=wide
in vec4 a_fgColor;     // fgRGBA

// Uniforms
uniform vec2 u_cellSize;    // cell dimensions in pixels
uniform vec2 u_gridSize;    // terminal cols, rows
uniform vec2 u_atlasSize;   // atlas texture dimensions

out vec2 v_texCoord;
out vec4 v_fgColor;
flat out float v_skip;

void main() {
  // Skip if cellSpan == 0 (wide char continuation)
  v_skip = a_cellSpan == 0.0 ? 1.0 : 0.0;

  // Compute cell position from gl_InstanceID
  int col = gl_InstanceID % int(u_gridSize.x);
  int row = gl_InstanceID / int(u_gridSize.x);

  // Cell origin in pixels (top-left)
  vec2 cellOrigin = vec2(float(col), float(row)) * u_cellSize;

  // Glyph quad position using bearing and atlas size
  vec2 glyphSize = a_atlasSize * u_atlasSize;
  vec2 glyphPos = cellOrigin + a_bearing + a_position * glyphSize;

  // Convert to NDC (assuming viewport matches canvas)
  vec2 canvasSize = u_gridSize * u_cellSize;
  vec2 ndc = (glyphPos / canvasSize) * 2.0 - 1.0;
  ndc.y = -ndc.y;  // Flip Y for top-left origin

  gl_Position = vec4(ndc, 0.0, 1.0);

  // Texture coordinates
  v_texCoord = a_atlasRect + a_position * a_atlasSize;
  v_fgColor = a_fgColor;
}
```

**Fragment shader (glyph pass):**
```glsl
#version 300 es
precision highp float;

uniform sampler2D u_atlas;

in vec2 v_texCoord;
in vec4 v_fgColor;
flat in float v_skip;

out vec4 fragColor;

void main() {
  if (v_skip > 0.5) discard;

  float alpha = texture(u_atlas, v_texCoord).a;
  fragColor = vec4(v_fgColor.rgb, v_fgColor.a * alpha);
}
```

**Tasks:**
1. Implement background pass (cell-aligned quads)
2. Implement glyph pass (bearing-offset quads)
3. Validate glyph overflow renders correctly
4. Handle wide glyphs (`cellSpan=2` uses double-width atlas entry)

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

**Tasks:**
1. Implement context loss handlers
2. Add renderer auto-detection and fallback
3. Run benchmark suite, compare to Canvas baseline
4. Document results and any regressions

**Deliverable:** Production-ready WebGL renderer shipping in vscode-bootty.

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

- [xterm.js addon-webgl](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl)
- [WebGL Instanced Drawing](https://webglfundamentals.org/webgl/lessons/webgl-instanced-drawing.html)
- [VS Code WebGL PR #84440](https://github.com/microsoft/vscode/pull/84440)
- ghostty-web Canvas renderer: `packages/ghostty-web/lib/renderer.ts`
- ghostty RenderState API: `packages/ghostty-web/lib/ghostty.ts`
