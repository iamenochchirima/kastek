# Project skill sources

These are the project-local Codex skills under `.agents/skills/`. A fresh checkout includes the
copies; it does not need the current user's global skill installation.

| Installed skill | Source and revision | Local notice |
| --- | --- | --- |
| `enoch-mode` | [`iamenochchirima/skills`, `d7788e4bfa3cff880b43cc236b0523a800a62586`](https://github.com/iamenochchirima/skills/tree/d7788e4bfa3cff880b43cc236b0523a800a62586/skills/enoch-mode) | [Enoch's MIT license](../../.agents/licenses/enoch-skills.txt) and [pstack's MIT license](../../.agents/licenses/pstack.txt) |
| `show-me-your-work` | [`iamenochchirima/skills`, `d7788e4bfa3cff880b43cc236b0523a800a62586`](https://github.com/iamenochchirima/skills/tree/d7788e4bfa3cff880b43cc236b0523a800a62586/skills/show-me-your-work) | [Enoch's MIT license](../../.agents/licenses/enoch-skills.txt) and [pstack's MIT license](../../.agents/licenses/pstack.txt) |
| `code-review`, `to-spec`, `to-tickets` | [`mattpocock/skills`, `c55ee46073ed923f86ce59a5eb3b6d895095d1b7`](https://github.com/mattpocock/skills/tree/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/engineering) | [Matt Pocock's MIT license](../../.agents/licenses/mattpocock-skills.txt) |

The adapted Enoch skills are based on [pstack at `ecc249f1e306fc64ddf83c7bed16cacf7c2239db`](https://github.com/cursor/plugins/tree/ecc249f1e306fc64ddf83c7bed16cacf7c2239db/pstack).
The project copy of `enoch-mode/SKILL.md` changes one provenance link so it resolves inside this
checkout; its workflow instructions and playbooks match the pinned source.

Do not update a copied skill by replacing it with an unpinned global installation. Review the
upstream change, update the project copy and this record together, then verify Codex discovers the
new copy. `triage` and `retro` are not installed here.
