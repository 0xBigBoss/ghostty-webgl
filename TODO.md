# TODO - Fix PTY Data Flow in BooTTY E2E Tests

## Completed
- [x] Run initial E2E test to establish baseline failure (iteration 1)
- [x] Analyze test artifacts and logs to identify PTY data flow break (iteration 1)
- [x] Trace PTY message delivery issue in webview (iteration 1)
- [x] Identify root cause: PTY visibility bypass needed (iteration 5)
- [x] Apply minimal fix in panel-view-provider.ts (iteration 5)
- [x] Verify E2E test passes (iteration 5)
- [x] Add test:e2e-render-compare script alias (iteration 7)
- [x] Implement file logger infrastructure for diagnostics (iteration 7)

## In Progress
- [ ] None

## Pending
- [ ] None

## Blocked
- [ ] None - Issue resolved

## Notes

### Root Cause
PTY data messages were being queued instead of delivered immediately when the panel was not visible. The `postMessage` method in `BooTTYPanelViewProvider` only sent messages when `this._view.visible` was true, causing PTY output to be lost or delayed during E2E tests where visibility state varies.

### Fix Applied
1. **PTY visibility bypass** in `panel-view-provider.ts`:
   - `pty-data` and `pty-exit` messages bypass the visibility check
   - Messages delivered immediately regardless of panel visibility
   - Ensures terminal output is never lost during background operation

2. **Script alias** in `package.json`:
   - Added `test:e2e-render-compare` as alias to `test:e2e`

3. **File logger infrastructure** (optional diagnostics):
   - `src/file-logger.ts` - JSONL file logger for extension host
   - `src/webview/webview-logger.ts` - Webview log forwarding
   - Enabled via `BOOTTY_FILE_LOG=/path/to/log.jsonl`

### Verification
```bash
BOOTTY_E2E_SHELL=/bin/sh BOOTTY_E2E_SUPPRESS_SHELL_RC=1 npm -C vscode-bootty run test:e2e-render-compare
```
Result: Exit code 0 (all tests pass)
