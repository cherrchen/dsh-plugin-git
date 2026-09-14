[中文](README.md) | English

# troubleshooting/ — Recurring issues and verified fixes

Holds **recurring problems, or problems whose diagnosis was expensive**: symptoms, root causes, and verified solutions.

- Admission: the problem recurred, or the root cause required archaeology, **and** the fix is verified. One-off error records and unverified guesses are not accepted.
- Suggested entry format: symptom (how it surfaced) → root cause (why it happened) → fix (what was changed, how it was verified) → related commits/tests.
- Documents here are not bilingual by mandate; empty `.en.md` stubs are forbidden.

## Entries

- [`git-rpc-channel-405.md`](git-rpc-channel-405.md) — `/git` RPC channel 405: a cordis nested fiber's property resolution cannot see `webServer`, so the channel silently never registers and all client UI goes blank. (Chinese canonical.)
- [`windows-desktop-console-flood.md`](windows-desktop-console-flood.md) — Windows desktop terminal-window flood with a blank Git UI: the host's `CreateProcessW` omits `CREATE_NO_WINDOW`, which multiplies focus events, while the client refresh neither coalesces nor lets overlapping rounds land. (Chinese canonical.)
