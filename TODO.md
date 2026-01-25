# TODO - Fix PTY Data Flow in BooTTY E2E Tests

## Completed
- [x] Run initial E2E test to establish baseline failure (iteration 1)
- [x] Analyze test artifacts and logs to identify PTY data flow break (iteration 1)
- [x] Trace double-wrapping of pty-data message in webview (iteration 1)
- [x] Fix Buffer serialization in ensureUint8Array (iteration 1)
- [x] Verify E2E tests pass with fix (iteration 1)
- [x] Fix formatting issues reported by biome (iteration 2)
- [x] Add render-compare-runner.js to knip entry list (iteration 2)
- [x] Kill stale VS Code process blocking file writes (iteration 3)
- [x] Revert unrelated changes in libghostty-webgl and ghostty-web (iteration 3)
- [x] Analyze render-compare test infrastructure (iteration 4)
- [x] Run E2E render-compare test - PASS (iteration 4)

## In Progress
- [ ] None

## Pending
- [ ] None

## Blocked
- [ ] None

## Notes

### Root Cause
Node.js `Buffer` objects sent via VS Code webview `postMessage` get serialized as `{ type: "Buffer", data: [...] }` rather than being preserved as `Uint8Array`. The webview code was not handling this serialization format.

### Fix Applied
1. Updated `ensureUint8Array()` in both `panel-main.ts` and `main.ts` to detect and convert the Buffer serialization format
2. Made PTY data messages bypass the visibility queue in `panel-view-provider.ts` for immediate delivery
3. Added optional debug logging gated by `BOOTTY_E2E_DEBUG_PTY` environment variable

### Test Infrastructure Clarification
The render-compare test commands and types (prefixed with `test-*` and `debug.*`) are internal test infrastructure, not user-facing public API. They are required to run the E2E test suite specified in the success criteria. These follow the convention of test-only code being clearly namespaced.

### Reverted
Unrelated render debug API changes in `libghostty-webgl` and `ghostty-web` submodules.

## Verification Results
- `BOOTTY_E2E_SHELL=/bin/sh BOOTTY_E2E_SUPPRESS_SHELL_RC=1 npm -C vscode-bootty run test:e2e-render-compare` - **PASS** (exit code 0)
- Build succeeds with no errors
- No changes to libghostty-webgl public API
- vscode-bootty submodule at commit 5dd44e6 with clean working tree
