# BooTTY Near-Native Optimization North Star

Goal: BooTTY in VS Code reaches near-native terminal performance by eliminating CPU bottlenecks in PTY drain/write and keeping render work minimal. We will implement **all** optimizations below and verify improvements with the benchmark suite and profiling traces until the near-native target is met.

---

## Success Criteria (Near-Native)

- **Throughput:** BooTTY WebGL throughput ≥ 0.8 × Ghostty in `benchmarks/compare.sh` output.
- **Drain behavior:** 90%+ of `bootty:webview:pty-drain` events hit the adaptive cap during stress cases.
- **Render cost:** `bootty:webgl:render` p95 ≤ 1.0 ms and total render time ≤ 5% of ptyStress wall time.
- **Scheduling:** No idle frames; only visible terminals render.

Use `docs/perf-acceptance.md` as the canonical pass/fail checklist.

---

## Benchmark + Profiling Workflow (Required)

### A) Run the VS Code bench suite

```sh
BOOTTY_BENCH_SCENARIOS=ptySuite \
BOOTTY_BENCH_OUTPUT=vscode-bootty/test/bench/workspace/tmp/bootty-bench-suite.json \
npm -C vscode-bootty run bench:e2e
```

Output includes:

- Suite results JSON: `vscode-bootty/benchmarks/results/bootty-YYYYMMDD-HHMMSS.json`
- JSONL profile: `vscode-bootty/.vscode-test/bench-user-data-*/logs/**/bootty-profiles/bootty-profile-*.jsonl`

### B) Analyze the JSONL profile

```sh
npm -C vscode-bootty run bench:analyze -- /path/to/bootty-profile-*.jsonl
```

### C) Compare with Ghostty

```sh
vscode-bootty/benchmarks/compare.sh
```

Capture the compare output alongside the JSON/JSONL paths for each run.

---

## Current Status (Latest Run)

- Suite output summary: `vscode-bootty/test/bench/workspace/vscode-bootty/test/bench/workspace/tmp/bootty-bench-suite.json`
- Suite results JSON: `vscode-bootty/benchmarks/results/bootty-20260119-112303.json`
- JSONL profile: `vscode-bootty/.vscode-test/bench-user-data-1768843360306/logs/20260119T112240/window1/exthost/bigboss.bootty/bootty-profiles/bootty-profile-a885e65a-b676-4fd9-98ee-c2fce9ef2217.jsonl`
- Compare output:

  ```
  Terminal Benchmark Comparison
  ==============================

  Terminal               Throughput   Scrollback       Colors      Unicode       Cursor     Var%         Date
                            (MiB/s)  (lines/sec)         (ms)         (ms)         (ms)    (max)
  --------------------------------------------------------------------------------------------------------
  ghostty                     66.66    249215.23         1068           23           27       40   2026-01-19
  bootty                      45.45    260036.81          951           15           22       30   2026-01-19

  Notes:
    - Higher is better for Throughput and Scrollback (lines/sec)
    - Lower is better for timed tests (Colors, Unicode, Cursor)
    - Var% shows max variance across tests; >10% indicates noisy results
  ```

---

## Optimization Plan (Implement All)

### 1) Binary Write Path (Highest Impact)

**Objective:** eliminate string-heavy drain/concat overhead.

**Implementation steps:**

1. End-to-end PTY output as `Uint8Array` (extension → webview).
2. Avoid `splitByLineCount` and string `slice/join` in hot path.
3. Decode once per frame **or** use terminal API that accepts binary directly.
4. If ghostty-web doesn’t accept binary, add a small adapter at the boundary (single decode per flush).

**Verify:**

- `bootty:webview:pty-write` duration drops significantly in stress traces.
- Fewer GC pauses during ptyStress in Chrome profiler (optional).

---

### 2) One-Write-Per-Frame Drain

**Objective:** minimize `term.write` calls under heavy output.

**Implementation steps:**

1. Drain to a byte budget each frame and assemble one payload.
2. Ensure only **one** `term.write(...)` call per frame during backlog drain.
3. Keep line limits as a safety guard only (do not let line caps throttle byte drain).

**Verify:**

- `bootty:webview:pty-write` count approximates frame count, not queue size.
- Throughput improves in `benchmarks/run.sh`.

---

### 3) Byte-First Adaptive Drain

**Objective:** treat bytes as the primary throttle, line counts secondary.

**Implementation steps:**

1. Enable byte-based adaptive drain when `ptyAdaptiveQueueBytesThreshold > 0`.
2. Add **min bytes per frame** in adaptive mode (e.g., 64–256 KiB).
3. Keep `maxBytesPerFrame` as a hard upper bound if configured.

**Verify:**

- Profile shows adaptive drain is active in stress, draining at/near target bytes.
- Queue bytes shrink quickly without line cap stalls.

---

### 4) Aggressive Upstream Batching (Extension Side)

**Objective:** reduce message overhead between extension and webview.

**Implementation steps:**

1. Increase `pty.outputBatchMaxBytes` for stress (start at 128–512 KiB).
2. Keep `pty.outputBatchMaxDelayMs` low (0–4 ms).
3. Ensure batching is disabled only for debugging or latency validation.

**Verify:**

- Fewer `pty-data` messages in logs.
- Improved throughput without increasing latency beyond acceptable thresholds.

---

### 5) Reduce String Churn in Drain

**Objective:** reduce allocations and copies in hot drain loop.

**Implementation steps:**

1. Replace per-chunk array `push/join` with a reusable buffer or single concat.
2. Avoid `splitByLineCount` scanning per chunk when adaptive byte drain is active.
3. Track offsets instead of slicing when possible.

**Verify:**

- Lower `bootty:webview:pty-drain` duration in profiles.
- Lower JS heap churn under heavy output (optional).

---

### 6) Worker Offload for Drain/Coalesce

**Objective:** keep the main thread focused on rendering + single write.

**Implementation steps:**

1. Move drain/merge into a Web Worker.
2. Send batched `Uint8Array` to main thread once per frame.
3. Keep main-thread logic minimal: just one write + scroll preservation.

**Verify:**

- Main thread `bootty:webview:pty-drain` duration drops to near-zero.
- Overall throughput increases in suite.

---

### 7) WASM Assist for Coalesce/Drain

**Objective:** lower CPU cost for large merges or line counting.

**Implementation steps:**

1. Optional: expose a WASM function to merge buffers or count newlines.
2. Use only when it measurably reduces wall time vs JS.

**Verify:**

- ptyStress duration improves and profiles show reduced drain time.

---

### 8) Message Consolidation at Webview Boundary

**Objective:** reduce queue length and scheduling overhead.

**Implementation steps:**

1. If multiple `pty-data` arrive in same tick, merge before enqueue.
2. Drop empty messages early.

**Verify:**

- Lower queue segment count for same byte volume.
- Reduced drain overhead per flush.

---

### 9) Render Loop Gating (Keep It Tight)

**Objective:** prevent hidden terminals from rendering.

**Implementation steps:**

1. Ensure inactive terminals always pause rendering.
2. Use shared render scheduler; no per-terminal RAF loops.
3. Avoid extra RAFs for idle behavior.

**Verify:**

- `bootty:render:raf-fired` only for visible terminals.
- Idle after initial render produces 0 extra frames.

---

### 10) Scrollback Preservation Optimizations

**Objective:** avoid extra work when not needed.

**Implementation steps:**

1. Only compute scroll deltas when viewport is offset.
2. Skip scroll preservation work when queue is large and user isn’t scrolled.

**Verify:**

- Reduced work inside `bootty:webview:pty-write` spans.

---

## Execution Rules

- Implement **one optimization at a time**.
- Run the full bench suite after each optimization.
- Record:
  - Suite JSON path
  - Profile JSONL path
  - `benchmarks/compare.sh` output
- Keep changes if they improve throughput or reduce `pty-write` CPU time.
- Roll back or revise if regression exceeds 3% in any key metric.

---

## Execution Checklist

- [x] Implement exactly one optimization from the list above.
- [x] Run `bench:e2e` with `BOOTTY_BENCH_SCENARIOS=ptySuite`.
- [x] Save/update suite JSON path in this file.
- [x] Save/update JSONL profile path in this file.
- [x] Run `bench:analyze` on the JSONL profile.
- [x] Run `benchmarks/compare.sh` and paste summary here.
- [x] Latest run recorded: `bootty-20260119-112303.json` (2026-01-19)
- [x] Decide to keep/adjust based on metrics and acceptance checklist.

---

## Current Evidence (Why This Plan Exists)

- Profiles show the bottleneck is CPU time in `bootty:webview:pty-write` and drain, not WebGL rendering.
- Throughput ~1.7–1.8 MiB/s indicates drain and write overheads dominate.
- Render time ~0.2 ms per frame suggests GPU path is already fast enough.

---

## Completion Definition

We stop only when **all** optimizations above are implemented, and the success criteria are met consistently across repeated runs.
