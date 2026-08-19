# Agent identity and isolation fix checklist

Focused remediation for user-created hosted agents being presented as KasiAi or KasiTek platform assistants.

- [x] Give every user-created agent a neutral runtime identity based on its name and purpose.
- [x] Require a strict unknown-answer rule: use configured knowledge first, do not invent, and do not fall back to KasiTek platform guidance.
- [x] Apply KasiAi-only instructions, preferences, and protected context only to the protected `system_hosted` KasiAi installation.
- [x] Keep knowledge, memory, conversations, runs, tools, and channels scoped to the selected agent installation.
- [x] Remove `kasiai` naming from generic hosted-agent conversations and errors.
- [x] Prevent internal grounding wrappers and capability metadata from appearing in user-facing replies.
- [x] Add regression coverage proving a custom agent cannot retrieve KasiAi-only knowledge or memory (existing integration coverage in `agents/test/memory.integration.test.ts`).
- [ ] Verify the custom-agent test chat with unique knowledge, missing knowledge, and a separate KasiAi conversation.

The implementation batch covers the first seven items and targeted unit/integration coverage. Full cross-agent runtime verification remains open until the custom-agent test chat is exercised with unique knowledge, missing knowledge, and a separate KasiAi conversation.
