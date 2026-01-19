# ghostty-webgl

WebGL2 GPU-accelerated terminal rendering for ghostty-web.

## Focus

- Keep investigating performance issues in the BooTTY WebGL2 renderer and push toward near-native rendering performance.

## Structure

- `ghostty/` - Submodule: Zig source (WASM build reference)
- `packages/ghostty-web/` - Submodule: ghostty-web fork (Canvas2D, adding WebGL)
- `packages/libghostty-vt/` - WASM + minimal JS bindings (to be extracted)
- `packages/libghostty-webgl/` - WebGL2 renderer (to be created)

## Commands

```sh
bun install          # Install dependencies
bun run typecheck    # TypeScript check via tsgo
bun run lint         # Lint with oxlint
bun run fmt          # Format with oxfmt
bun run knip         # Dead code detection
bun run cpd          # Copy-paste detection
```

## Tooling

- **tsgo** - Native TypeScript compiler (@typescript/native-preview)
- **oxlint/oxfmt** - Fast linting and formatting
- **lefthook** - Git hooks (pre-commit: lint, fmt, typecheck; pre-push: knip, cpd)
- **knip** - Unused exports/dependencies
- **jscpd** - Duplicate code detection
