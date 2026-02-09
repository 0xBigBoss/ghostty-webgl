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
- [x] Fix visual rendering bug with zsh - normalizeBackspace was not being called
- [x] Add E2E test for zsh autosuggestion backspace sequences

## In Progress

## Pending

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

### Visual Rendering Bug Investigation (zsh)

**Symptom**: Terminal displays `$echo hwolo world` instead of `$echo hello world` when using zsh.

**E2E Test Coverage Analysis**:

1. **E2E tests use `/bin/sh`**: Simple shell without autosuggestion or complex readline features
2. **E2E tests check buffer content via `findText`**: Verifies text exists in buffer, not visual correctness
3. **E2E zsh-like test exists but uses controlled sequences**: Test at `runner.js:547-590` sends a known escape sequence that the WASM terminal handles correctly

**Why E2E Tests Pass But Visual Rendering Breaks**:

The E2E `zshPayload` test uses this controlled sequence:
```javascript
const zshPayload = [
  "\x1b[2J\x1b[H",  // Clear screen, cursor home
  "echo ", "h", "\b",  // Write "h", then backspace
  "\x1b[1m\x1b[31m", "h", "\x1b[0m\x1b[39m",  // Bold red "h"
  "ello ", "world", "\x1b[5D", "\x1b[90m", "world", ...
].join("");
```

**Key difference**: Real zsh sends escape sequences based on:
- User's zsh configuration
- Autosuggestion plugin state
- Terminal capabilities detection
- Readline/ZLE state

These sequences may include cursor movement, character replacement, or attribute changes that trigger edge cases in ghostty-vt's VT parser.

**Proposed Solutions**:

1. **Add escape sequence edge case tests**: Create additional `directWrite` tests with more complex cursor movement patterns
2. **Test with recorded zsh sessions**: Capture actual escape sequences from zsh and replay them in E2E tests
3. **Visual snapshot testing**: Compare canvas screenshots against expected renders (expensive but catches visual bugs)
4. **Investigate ghostty-vt**: Check if the WASM terminal correctly handles backspace + cursor movement combinations

**Files to Investigate**:
- `packages/ghostty-web/lib/ghostty.ts` - WASM terminal wrapper
- `packages/ghostty-web/lib/terminal.ts` - Terminal.write() and viewport cell composition
- Ghostty upstream - VT parser in Zig

### PTY Capture Instrumentation

Added `bootty.togglePtyCapture` VS Code command to capture raw PTY bytes for debugging.

**Usage**:
1. Open Command Palette (Cmd+Shift+P / Ctrl+Shift+P)
2. Run "BooTTY: Toggle PTY Capture"
3. Type in the terminal to capture escape sequences
4. Run "BooTTY: Toggle PTY Capture" again to stop

**Output Location** (same as render profiles):
```
~/.config/Code/logs/{date}/window{N}/exthost/bigboss.bootty/bootty-profiles/pty-capture-{uuid}.jsonl
```

**Output Format** (JSONL):
```json
{"type":"start","ts":0,"path":"/tmp/pty-capture.jsonl","startTime":"2026-01-25T..."}
{"ts":0.123,"id":"term-abc","hex":"1b5b48","escaped":"\\x1b[H","len":3}
{"ts":0.456,"id":"term-abc","hex":"68656c6c6f","escaped":"hello","len":5}
{"type":"end","ts":10.789,"endTime":"2026-01-25T..."}
```

**Fields**:
- `ts`: Timestamp in seconds since capture start
- `id`: Terminal ID
- `hex`: Raw bytes in hexadecimal
- `escaped`: Human-readable escaped string (\\x1b for ESC, \\n for newline, etc.)
- `len`: Byte length

**To reproduce the bug**:
1. Open BooTTY panel
2. Run "BooTTY: Toggle PTY Capture" command
3. Choose save location
4. Type "echo hello world" in zsh
5. Run "BooTTY: Toggle PTY Capture" again to stop
6. Examine the JSONL file

**Files Changed**:
- `vscode-bootty/src/terminal-manager.ts` - Added `togglePtyCapture()` and `capturePtyData()` methods
- `vscode-bootty/src/extension.ts` - Registered `bootty.togglePtyCapture` command
- `vscode-bootty/package.json` - Added command and activation event

### zsh Rendering Bug Fix

**Root Cause**: The `normalizeBackspace` method existed in `packages/ghostty-web/lib/terminal.ts` but was **never called** in the write path. Zsh sends backspace characters (0x08 / `\b`) for autosuggestion features, and these were being passed directly to ghostty-vt which doesn't handle raw backspace the same way.

**Symptom**: Typing "echo hello world" displayed as "echo wohello world" or similar garbled text.

**Fix Applied**: In `packages/ghostty-web/lib/terminal.ts:624`:
```typescript
// Before (bug):
const normalized = data;

// After (fix):
const normalized = this.normalizeBackspace(data);
```

The `normalizeBackspace` method converts backspace characters (0x08) to CSI cursor left sequences (`\x1b[D`), which ghostty-vt handles correctly.

**Files Changed**:
- `packages/ghostty-web/lib/terminal.ts` - Call normalizeBackspace in writeInternal() (+1 line change)

### E2E Test for zsh Autosuggestion Backspaces

Added a new directWrite test in `vscode-bootty/test/e2e/runner.js` that exercises the normalizeBackspace fix using escape sequences captured from real zsh autosuggestion behavior.

**Test payload** (simplified from PTY capture):
```javascript
const zshAutoPayload = [
  "\x1b[2J\x1b[H", // Clear screen, cursor home
  "e",
  "\b", // backspace - zsh erases to redraw with color
  "\x1b[1m\x1b[31me\x1b[0m\x1b[39m", // bold red "e"
  "\b", // backspace again for another redraw cycle
  "\x1b[1m\x1b[31me\x1b[0m\x1b[39m", // bold red "e" again
  "\x1b[90mcho hello world\x1b[39m", // faint gray autosuggestion
  "\x1b[15D", // cursor back to after "e"
  "\b\b\b\b", // multiple backspaces (zsh editing)
  "\x1b[0m\x1b[32mecho\x1b[39m", // green "echo"
  " hello world", // rest of text
  "\x1b[H", // cursor home
  `\x1b[${zshAutoExpected.length}C`, // move cursor to end
].join("");
```

**Verification**: Samples trailing cells and asserts:
1. Text content is "echo hello world" (backspaces converted to cursor movement)
2. All non-space characters have visual ink (rendered correctly)

**Files Changed**:
- `vscode-bootty/test/e2e/runner.js` - Added zsh autosuggestion backspace test (+40 lines)

### Continued Investigation: normalizeBackspace runs but display still broken

**Symptom**: Console logs confirm `normalizeBackspace` IS running:
```
[ghostty-web] normalizeBackspace: Uint8Array has backspaces, converting...
```
But the display still shows garbled text: "echo hwolo world" instead of "echo hello world".

**Key Observation**:
- Command OUTPUT is correct ("hello world", "test test test")
- Only the DISPLAY of typed commands is wrong
- Issue occurs even with `/bin/sh` (simple shell)

**E2E Tests All Pass**:
- `backspace-basic`: "AB\bC" → "AC" ✓
- `backspace-multi`: "ABC\b\bDE" → "ADE" ✓
- `backspace-start`: "\bA" → "A" ✓
- `backspace-sgr`: "AB\b\x1b[31mC\x1b[0m" → "AC" ✓
- `zsh-autosuggestion-backspaces`: Complex zsh sequence → "echo hello world" ✓
- `shell-style echo with SGR`: Characters with bold → "echo hello" ✓
- `interleaved backspaces`: "hello\b\b\bLLO" → "heLLO" ✓
- `rapid writes with renders`: Character-by-character writes → "hello world" ✓

**Unit Tests All Pass**:
All terminal.test.ts tests pass, including new tests that simulate shell-like behavior.

**Current Hypothesis**:
The issue is specific to the VS Code webview + real shell interaction. Possible causes:
1. PTY worker batching/timing with real async I/O
2. WebGL renderer issues specific to VS Code's webview context
3. Race between PTY data arrival and render scheduling
4. Something about the shell's actual escape sequences that differs from tests

**Diagnostic Code Added**:
1. `packages/ghostty-web/lib/terminal.ts`:
   - Added `window.GHOSTTY_DEBUG_WRITES = true` flag to enable verbose write logging
   - Logs raw input bytes, cursor positions, and viewport state after each write

2. `packages/ghostty-web/lib/renderer.ts`:
   - Logs first 3 rows of viewport cells during full renders

3. `packages/libghostty-webgl/src/CellBuffer.ts`:
   - Added `window.BOOTTY_DEBUG_CELLS = true` flag
   - Logs cells received by WebGL renderer

**To Debug in VS Code**:
1. Open Command Palette (Cmd+Shift+P / Ctrl+Shift+P)
2. Run "BooTTY: Toggle Render Debug Mode" to enable debug logging
3. Open Developer Tools (Help > Toggle Developer Tools or F12)
4. Type in the BooTTY terminal
5. Compare logs from ghostty-web and webgl-cellbuffer to see if data differs
6. Run "BooTTY: Toggle Render Debug Mode" again to disable

**Files Modified**:
- `packages/ghostty-web/lib/terminal.ts` - Verbose write logging
- `packages/ghostty-web/lib/terminal.test.ts` - Added shell simulation tests
- `packages/ghostty-web/lib/renderer.ts` - Viewport cell logging
- `packages/libghostty-webgl/src/CellBuffer.ts` - WebGL cell logging

**Next Steps**:
1. Manually test with debug flags enabled in VS Code
2. Compare viewport cell logs from terminal.ts vs CellBuffer.ts
3. If cells differ, issue is in render input composition
4. If cells are same, issue is in WebGL glyph rendering

If manual testing still shows issues after these diagnostics, reload VS Code to clear webview cache.

### Further Investigation: Rapid Multi-Write E2E Test

**PTY Capture Analysis**:
Analyzed existing PTY captures at `~/.config/Code/logs/*/exthost/bigboss.bootty/bootty-profiles/pty-capture-*.jsonl`. Key findings:
- zsh sends data in rapid bursts (multiple messages within 1-5ms)
- Each keystroke triggers multiple PTY messages with backspaces and escape sequences
- Example flow for typing "echo":
  1. ts=12.088: 'e' (1 byte)
  2. ts=12.092: `\b\x1b[1m\x1b[31me\x1b[0m\x1b[39m` (20 bytes) - backspace + styled 'e'
  3. ts=12.092: More sequences with autosuggestion (36 bytes)
  4. ... continued rapid bursts

**New E2E Test Added**:
Created a rapid multi-write test in `runner.js` that sends the exact captured sequences as separate writes with timing delays to simulate real PTY message patterns:
```javascript
// Test rapid multi-write PTY pattern (from real zsh capture)
await directWrite(directTerminalId, "\x1b[2J\x1b[H", READY_TIMEOUT_MS);
await directWrite(directTerminalId, "e", READY_TIMEOUT_MS);
await new Promise((r) => setTimeout(r, 5)); // Small delay
await directWrite(directTerminalId, "\b\x1b[1m\x1b[31me\x1b[0m\x1b[39m", READY_TIMEOUT_MS);
// ... more writes following exact capture pattern
```

**Test Results**:
- All E2E tests PASS including the new rapid multi-write test
- Tests pass with `/bin/sh` shell
- Tests pass with `/bin/zsh` shell
- Tests pass with WebGL renderer (`BOOTTY_E2E_RENDERER=webgl`)
- Tests pass with canvas renderer (default)

**Conclusion**:
The bug cannot be reproduced in E2E tests even when:
1. Using exact captured escape sequences from real zsh usage
2. Simulating rapid multi-write patterns with timing delays
3. Using WebGL renderer
4. Using zsh as the shell

The issue appears to be specific to the real VS Code runtime environment, possibly related to:
1. User's specific zsh configuration (plugins, themes, prompt)
2. VS Code webview state/lifecycle that differs in E2E tests
3. GPU/WebGL context behavior in the user's environment
4. Timing differences between automated tests and real user interaction

**Next Steps**:
1. Enable debug flags in real VS Code (`window.GHOSTTY_DEBUG_WRITES = true; window.BOOTTY_DEBUG_CELLS = true;`)
2. Reproduce the bug while watching console logs
3. Compare cursor positions and cell content between writes
4. Look for any discrepancies between terminal.ts viewport and CellBuffer.ts WebGL data

### Root Cause Identified: zsh-autosuggestions Silent Character Acceptance

**Debug Session Analysis (2026-01-26)**:

Using the new `bootty.toggleRenderDebug` command, detailed console logs revealed the exact mechanism of the bug.

**Key Observation: Missing PTY Responses**

When typing "echo hello world" with zsh-autosuggestions:
1. User types 'e', 'c' → shell sends styled echo + autosuggestion "echo BOOTTY_KEY_BACKSPACE_TEST"
2. User types 'h', 'o' → shell sends styled echo + updates autosuggestion
3. User types 'h' (start of "hello") → shell sends 180-byte response with "hello world" suggestion
4. User types 'e', 'l', 'l', 'o', ' ' → **NO PTY output!** (silent acceptance)
5. User types 'w' → shell sends 17-byte response

The gap between steps 3-5 is critical: zsh-autosuggestions does NOT send any PTY output for characters that match the current autosuggestion. It silently accepts them internally.

**Cursor Position Mismatch**:

After the 180-byte write:
- Cursor position in ghostty-vt: column 7 (from `\x1b[10D` at end of sequence)
- User then types 5 more chars ('e', 'l', 'l', 'o', ' ') with NO PTY output
- zsh expects cursor to be at column 12 (after "hello ")
- ghostty-vt still has cursor at column 7

When 'w' is typed, the 17-byte response writes 'w' at column 7, overwriting 'e' → "hwllo"

**Trace of Write #8 (the 'w' keystroke)**:
```
Input: \x1b[39mw\b\x1b[4mw\x1b[24m
- Write 'w' at column 7 (should be column 12)
- BS (cursor left to 6)
- Underline 'w' at column 6
Result: 'w' overwrites 'e' at column 7 → "hwllo" instead of "hello"
```

**Why E2E Tests Pass**:

E2E tests use `directWrite` which sends the captured PTY sequences directly. The sequences include all the escape codes for cursor positioning. But the REAL zsh behavior has gaps where no PTY output is sent for matching autosuggestion characters.

**Hypothesis**:

zsh-autosuggestions uses a mode where matching characters are "accepted" without terminal updates. In native terminals (iTerm2, GNOME Terminal), this works because either:
1. The terminal has local echo mode for certain operations
2. The shell uses a terminal capability that ghostty-vt doesn't support
3. There's some synchronization mechanism we're missing

**Potential Fixes**:

1. **Investigate zsh-autosuggestions settings**:
   - `ZSH_AUTOSUGGEST_STRATEGY` - might affect how suggestions are accepted
   - `ZSH_AUTOSUGGEST_ACCEPT_WIDGETS` - controls which widgets accept suggestions
   - Try disabling the plugin to confirm it's the cause

2. **Check terminal capabilities**:
   - Verify `$TERM` is set correctly (should be `xterm-256color` or similar)
   - Check if zsh queries any capabilities that ghostty-vt doesn't respond to

3. **Add cursor tracking for input**:
   - When input is sent to PTY, track where cursor SHOULD be if char is echoed
   - Use this expected position for writes that arrive after delays

4. **PTY echoing investigation**:
   - Check if the PTY is in raw mode vs cooked mode
   - Some modes might handle echoing differently

**Files Involved**:
- `packages/ghostty-web/lib/terminal.ts` - normalizeBackspace, cursor tracking
- `vscode-bootty/src/terminal-manager.ts` - PTY input/output handling
- `vscode-bootty/src/pty-service.ts` - PTY spawn configuration

### Fix Applied: Stop Converting BS to CSI-D for Uint8Array (2026-01-27)

**Root Cause Analysis** (from Codex agent):
The `normalizeBackspace()` function was converting BS (0x08) to CSI-D for ALL input, including Uint8Array PTY output. This caused cursor drift because:
1. ghostty-vt handles BS and CSI-D with subtly different semantics
2. zsh/bash rely on precise BS behavior for cursor positioning
3. Converting BS to CSI-D changed the cursor state in ways that caused subsequent writes to land at wrong positions

**Fix Applied** in `packages/ghostty-web/lib/terminal.ts`:

1. **`normalizeBackspace` simplified** (lines 740-752):
   - For Uint8Array (PTY output): pass through unchanged
   - For string input (user-typed data): still convert BS to CSI-D

   ```typescript
   private normalizeBackspace(data: string | Uint8Array): string | Uint8Array {
     if (typeof data !== "string") {
       return data;  // Pass Uint8Array unchanged - let ghostty-vt handle BS directly
     }
     if (!data.includes("\b")) return data;
     return data.replace(/\x08/g, Terminal.CSI_LEFT);
   }
   ```

2. **`needsFullRender` uses original hasBS** (line 641):
   - Check for BS in original data BEFORE normalization
   - Force full render when BS present (cursor movement may overwrite cells)

   ```typescript
   const hasBS = typeof data === "string" ? data.includes("\b") : data.includes(0x08);
   const normalized = this.normalizeBackspace(data);
   const analysis = this.analyzeWriteControls(normalized);
   const needsFullRender = analysis.forceFullReason !== null || hasBS || analysis.hasCarriageReturn;
   ```

**E2E Tests Added** in `packages/ghostty-web/playwright/tests/functional/backspace-cursor.spec.ts`:
- "CSI D with count should move cursor correctly" - verifies ESC[nD moves cursor correctly
- "zsh autosuggest sequence cursor position tracking" - documents mathematically correct cursor behavior
- "plain text echo renders without BS or CR" - verifies character-by-character echo works
- "plain text echo via Uint8Array renders correctly" - verifies Uint8Array path works

**Test Results**:
- All 7 E2E tests pass (backspace-cursor.spec.ts)
- 334/336 unit tests pass (2 pre-existing failures unrelated to this fix)

**Bash Echo Issue Report**:
User reported that with plain bash (`/usr/bin/sh`), typed characters don't appear on screen until command output. Analysis:
1. E2E tests for plain text echo pass (both string and Uint8Array)
2. Core rendering works correctly (confirmed by tests)
3. Issue may be specific to VS Code integration (PTY→extension→webview pipeline)
4. Could also be transient state issue resolved by rebuild

**To Verify Fix Works**:
1. Rebuild all packages: `npm -C packages/ghostty-web run build && npm -C packages/libghostty-webgl run build && npm -C vscode-bootty run build`
2. Reload VS Code window
3. Open BooTTY terminal with zsh
4. Type "echo hello world" - should display correctly without garbling

**Shell Config Added** (by Codex agent):
`vscode-bootty/src/terminal-manager.ts` - Added `resolveShellConfig()` for `bootty.shell` and `bootty.shellArgs` settings
