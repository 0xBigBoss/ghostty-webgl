# WebGL Terminal Rendering Research

## Current State: vscode-bootty

- **Location**: `/Users/allen/0xbigboss/vscode-bootty/`
- **Rendering**: Canvas2D via `@0xbigboss/ghostty-web` (v0.5.0)
- **VT Emulation**: libghostty-vt WASM (~413KB)
- **Stack**: TypeScript + esbuild + VS Code webview

## ghostty-web Package Analysis

**Source**: https://github.com/coder/ghostty-web (your fork: 0xBigBoss/ghostty-web)

### Exports
- `Terminal` - Main terminal class (xterm.js API compatible)
- `Ghostty` - WASM wrapper for ghostty-vt runtime
- `CanvasRenderer` - Canvas2D renderer
- `KeyEncoder` - Keyboard → escape sequences
- `FitAddon` - Auto-resize terminal to container
- `SelectionManager`, `LinkDetector`, `InputHandler`

### WASM Functions (ghostty-vt.wasm)
- `ghostty_terminal_new/write/resize` - Terminal lifecycle
- `ghostty_render_state_update/get_viewport` - Render state access
- `ghostty_key_encoder_*` - Key encoding
- `ghostty_sgr_*` - SGR parsing

### Build Pipeline
- Zig compiles ghostty source → WASM
- `patches/ghostty-wasm-api.patch` exposes additional APIs
- Vite bundles TypeScript wrapper

---

## WebGL Terminal Implementations

### xterm.js addon-webgl

**Architecture**:
- WebGL2-based, optional addon loaded separately
- Glyph atlas: 32×1 grid per texture layer
- ASCII fast path: `glyph_id = char_code | style_bits`
- Single `drawArraysInstanced()` call per frame

**Key Techniques**:
- 6 buffers in VAO for state-free rendering
- `vertexAttribDivisor()` for per-instance attributes
- Context loss handling via `onContextLoss()` API

### Ghostty Native (Metal/OpenGL)

**Architecture**:
- Platform-native GPU APIs (Metal on macOS, OpenGL on Linux)
- CPU: text parsing, terminal state
- GPU: font rasterization, rendering
- Custom GLSL shaders supported (~1-2% overhead)

**Design Philosophy**:
- Separates parsing (CPU) from rendering (GPU)
- Multi-threaded with significant idle time between frames

### Common Patterns

**Glyph Atlas Strategy**:
1. Canvas-to-texture: Rasterize via HTML5 canvas → WebGL texture
2. Sub-pixel variants: 4 versions at 0.0, 0.33, 0.66, 1.0 offsets
3. LRU cache for unicode exceeding atlas capacity

**Instanced Rendering Pipeline**:
```
Per-vertex (static):  quad position (-1..+1)
Per-instance (dynamic): cell_pos, glyph_id, fg_color, bg_color
```

**Buffer Layout**:
- Position buffer: 4 vertices × 2 floats (static)
- Instance buffer: cell data (dynamic, ring buffer)
- VAO encapsulates all bindings

---

## Performance Benchmarks (VS Code PR #84440)

| Platform | Terminal Size | Speedup vs Canvas2D |
|----------|---------------|---------------------|
| Windows | 87×26 | 901% |
| Windows | 300×80 | 839% |
| macOS | 300×80 | 314% |

---

## Architecture Boundary: VT vs Rendering

```
Input: Bytes from shell/PTY
  ↓
libghostty-vt: Parse VT sequences → terminal state (cells, cursor, attrs)
  ↓
Rendering layer: Draw pixels from state
  ↓
Platform: Display to user
```

**libghostty-vt provides**:
- VT100/xterm escape sequence parsing
- Terminal state (cursor, cells, scrollback)
- Unicode/grapheme handling
- Key encoding (Kitty protocol, xterm modifyOtherKeys)

**libghostty-vt does NOT include**:
- Rendering/GPU operations
- Font handling
- Platform-specific UI

---

## Existing Workspace Assets

| Location | Description |
|----------|-------------|
| `/Users/allen/0xbigboss/ghostty/` | Ghostty source clone (fork remote available) |
| `/Users/allen/0xbigboss/ghostty-vscode/` | Earlier PoC monorepo |
| `/Users/allen/0xbigboss/ghostty-vscode/ghostty-web/` | ghostty-web fork (v0.5.0) |
| `/Users/allen/0xbigboss/vscode-bootty/` | Production VS Code extension |

---

## Key Implementation Considerations

1. **Dual renderer support** - Keep Canvas2D for fallback
2. **Context loss recovery** - Design from start, not afterthought
3. **ASCII optimization** - 95%+ of terminal content is ASCII
4. **Glyph atlas coordination** - Texture coordinate precision affects quality
5. **Buffer management** - Ring buffer prevents reallocation per frame

---

## Sources

- [xterm.js WebGL Addon](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl)
- [@xterm/addon-webgl npm](https://www.npmjs.com/package/@xterm/addon-webgl)
- [VS Code WebGL PR #84440](https://github.com/microsoft/vscode/pull/84440)
- [Ghostty GitHub](https://github.com/ghostty-org/ghostty)
- [Ghostty Devlog 005](https://mitchellh.com/writing/ghostty-devlog-005)
- [libghostty roadmap](https://mitchellh.com/writing/libghostty-is-coming)
- [Warp Glyph Atlases](https://www.warp.dev/blog/adventures-text-rendering-kerning-glyph-atlases)
- [WebGL Instanced Drawing](https://webglfundamentals.org/webgl/lessons/webgl-instanced-drawing.html)
- [coder/ghostty-web](https://github.com/coder/ghostty-web)
