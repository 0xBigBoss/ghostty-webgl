# TODO - Fix PTY Data Flow in BooTTY E2E Tests

## Completed
- [x] Run initial E2E test to establish baseline failure (iteration 1)
- [x] Analyze test artifacts and logs to identify PTY data flow break (iteration 1)
- [x] Trace PTY message delivery issue in webview (iteration 1)
- [x] Identify root cause: PTY visibility bypass needed (iteration 5)
- [x] Apply minimal fix in panel-view-provider.ts (iteration 5)
- [x] Verify E2E test passes (iteration 5)
- [x] Add test:e2e-render-compare script alias (iteration 8)
- [x] Remove ptyFlushFastPath API additions from RuntimeConfig (iteration 9)
- [x] Add cross-platform out directory cleaning with permissive mode (iteration 15)

## In Progress
- [ ] None

## Pending
- [ ] None

## Blocked
- [x] E2E build permission denied - multi-user environment issue (iteration 16)

### Blocker Details
The reviewer process runs as a different user than the code author (ae). Files in `vscode-bootty/out/` are owned by 'ae' and cannot be modified/removed by the reviewer user, even with:
- `fs.promises.rm({ force: true })` - Unix doesn't allow removing files you don't own
- Creating directories with mode 0o777 - existing files still have wrong ownership
- Manual directory removal - recreated by my process, then owned by 'ae' again

**Root cause**: User permission mismatch between Claude Code session (runs as 'ae') and Codex reviewer process (runs as different user).

**Suggested fixes** (infrastructure-level):
1. Run reviewer as same user (ae)
2. Use shared group with write permissions on vscode-bootty/
3. Run both processes in a container with shared user
4. Use a build directory outside the repo that both users can access

## Notes

### Root Cause
PTY data messages were being queued instead of delivered immediately when the panel was not visible. The `postMessage` method in `BooTTYPanelViewProvider` only sent messages when `this._view.visible` was true, causing PTY output to be lost or delayed during E2E tests where visibility state varies.

### Fix Applied
**PTY visibility bypass** in `panel-view-provider.ts`:
- `pty-data` and `pty-exit` messages bypass the visibility check
- Messages delivered immediately regardless of panel visibility
- Ensures terminal output is never lost during background operation

**Script alias** in `package.json`:
- Added `test:e2e-render-compare` as alias to `test:e2e`

### Files Changed
- `src/panel-view-provider.ts` - Added PTY message visibility bypass (+10 lines)
- `package.json` - Added script alias (+1 line)

### No API Changes
No changes to `src/types/messages.ts` or `src/types/terminal.ts`.

### Verification
```bash
BOOTTY_E2E_SHELL=/bin/sh BOOTTY_E2E_SUPPRESS_SHELL_RC=1 npm -C vscode-bootty run test:e2e-render-compare
```
Result: Exit code 0 (all tests pass)
