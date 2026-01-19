# BooTTY WebGL2 Performance Acceptance Checklist

All items are strict pass/fail. Record results per run and keep the raw JSONL profiles.

## A. Render Scheduling (No Wasted Work)

- [ ] With 2 tabs open, only the active terminal emits `bootty:render:raf-fired` for 10s idle.
- [ ] Closing a terminal stops its `bootty:render:*` and `bootty:webview:pty-drain` within 1s.
- [ ] With 4 tabs open, total `bootty:render:raf-fired` per frame equals the number of **visible** terminals only.

## B. PTY Drain / Throughput (Near-Native Target)

- [ ] `bootty` (WebGL) throughput ≥ 0.8 × `ghostty` throughput in `benchmarks/compare.sh` output.
- [ ] ptyStress completes in ≤ 2 frames (count of `bootty:render:frame` during the case).
- [ ] ≥ 90% of `bootty:webview:pty-drain` events drain at the configured WebGL cap.

## C. Render Cost (WebGL Not Bottleneck)

- [ ] `bootty:webgl:render` p95 ≤ 1.0ms.
- [ ] `bootty:webgl:render` total time ≤ 5% of ptyStress wall time.

## D. Stability / Regression Guards

- [ ] Idle for 30s after initial render produces **0** extra frames.
- [ ] Open/close terminals 10× does not increase active render loops.

## E. Data Integrity

- [ ] JSONL includes both `bootty:extension:runtime-config` and `bootty:webview:runtime-config`.
- [ ] `BOOTTY_BENCH_OUTPUT` writes a results file containing all scenarios.

## Validation Steps (Manual)

- Run the bench harness and collect JSONL profiles.
- Analyze with `npm -C vscode-bootty run bench:analyze -- /path/to/profile.jsonl`.
- Save `benchmarks/compare.sh` output alongside JSONL paths.
