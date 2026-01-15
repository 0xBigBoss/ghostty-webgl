# ghostty-webgl

WebGL2 GPU-accelerated terminal rendering for ghostty-web.

## Goal

Replace Canvas2D rendering in ghostty-web with a WebGL2 renderer for 3-9x performance improvement, enabling smooth 300x80+ terminal rendering.

## Package Architecture

```
ghostty-webgl/
├── ghostty/                     # Submodule → 0xBigBoss/ghostty (Zig source)
├── packages/
│   ├── libghostty-vt/           # WASM + minimal JS bindings
│   ├── libghostty-webgl/        # WebGL2 renderer (NEW)
│   └── ghostty-web/             # Submodule → 0xBigBoss/ghostty-web
└── apps/
    └── demo/                    # Test harness
```

### Package Responsibilities

| Package | Purpose |
|---------|---------|
| `libghostty-vt` | WASM binary + loader. VT parsing, terminal state, key encoding. Zero rendering. |
| `libghostty-webgl` | WebGL2 renderer. Glyph atlas, instanced rendering, shaders. |
| `ghostty-web` | High-level Terminal class. xterm.js API compatibility. Renderer abstraction. |

## Implementation Phases

### Phase 1: Workspace Setup
- [ ] Create monorepo with bun workspaces
- [ ] Add ghostty submodule (Zig source for WASM reference)
- [ ] Add ghostty-web submodule (your fork)
- [ ] Extract libghostty-vt package from ghostty-web

### Phase 2: Glyph Atlas System
- [ ] Canvas2D font rasterization → WebGL texture
- [ ] ASCII fast path (chars 0-127 pre-rendered)
- [ ] LRU cache for unicode/emoji glyphs
- [ ] Sub-pixel glyph variants (3-4 offsets)

### Phase 3: WebGL2 Instanced Renderer
- [ ] WebGL2 context setup with fallback detection
- [ ] Vertex shader: instanced quad positioning
- [ ] Fragment shader: glyph texture sampling + colors
- [ ] VAO-based single draw call per frame
- [ ] Dirty region tracking (only update changed cells)

### Phase 4: Integration
- [ ] Renderer abstraction in ghostty-web (canvas vs webgl)
- [ ] Context loss recovery (`webglcontextlost` handling)
- [ ] Selection rendering (background layer)
- [ ] Cursor rendering (animated)
- [ ] Settings: `rendererType: 'webgl' | 'canvas'`

### Phase 5: vscode-bootty Integration
- [ ] Update vscode-bootty to use new packages
- [ ] WebGL availability detection in VS Code webview
- [ ] Performance benchmarking vs Canvas2D

## Key Technical Decisions

1. **Instanced rendering** - Single quad geometry, per-cell instance data
2. **Glyph atlas** - 32x32 grid texture, O(1) UV lookups via bit ops
3. **ASCII optimization** - Direct bit manipulation for chars 0-127
4. **Fallback** - Keep Canvas2D path for WebGL unavailable contexts

## References

- xterm.js addon-webgl: https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl
- VS Code WebGL PR #84440: https://github.com/microsoft/vscode/pull/84440
- Ghostty GPU architecture: https://mitchellh.com/writing/ghostty-devlog-005
- libghostty roadmap: https://mitchellh.com/writing/libghostty-is-coming

## Related Repos

| Repo | Purpose |
|------|---------|
| `0xBigBoss/ghostty` | Zig source fork (WASM build reference) |
| `0xBigBoss/ghostty-web` | ghostty-web fork (Canvas2D, to add WebGL) |
| `0xBigBoss/vscode-bootty` | VS Code extension (consumer) |
