# Agents section: layout decision

Researched 2026-10-11. This is a design recommendation, not a user-tested result. The live landing page has not been changed by this research.

The competitor brief is [agents-presentation-research.md](../agents-presentation-research.md). Desktop screenshots here were captured from the live first-party sites at 1440 × 1000. They document a single browser state, not a site's complete motion or interaction behaviour. Reference images are for analysis, not assets to reuse on KasiTek's landing page.

## Visual observations

- [Lindy](https://www.lindy.ai/): the captured viewport shows a centered platform proposition surrounded by integration marks, followed by a Slack-style demo. That demo contains a specific question about ad spend and a response identifying the information being retrieved. Borrow the specific task and visible work, rather than its productivity multiplier or integration claims. See `lindy-desktop.png`.
- [Dust](https://dust.tt/): the captured hero uses an isometric arrangement of team shapes with an overlaid work conversation. Its accompanying text connects company knowledge, tools and teams. This illustrates that a broad agent platform can have one visual identity while depicting different work contexts. See `dust-desktop.png`.
- [Relevance AI](https://relevanceai.com/): the captured top section promotes Invent 2.0 with a purple character, then shifts toward teams of agents. This is an alternative character-led approach. It is a weaker fit for the warm editorial direction already chosen for Labs. See `relevance-desktop.png`.

## Research constraints that affect the layout

Nielsen Norman Group explains that default tabs receive more attention and other panels can be ignored. Critical information should therefore not exist only in a nondefault panel. For this section, all three audience names and a short explanation should remain visible. A user can select a demo without needing to select it to understand the category. [Tabs, Used Right](https://www.nngroup.com/articles/tabs-used-right/)

NN/G's auto-forwarding study documents a user missing the information they sought when a panel rotated away. Keep category switching manual. Motion can unfold inside the chosen scene, then hold on its readable final state. [Auto-Forwarding Carousels and Accordions](https://www.nngroup.com/articles/auto-forwarding/)

Microsoft's human-AI guidelines advise communicating system capabilities and making explanations available. Applied to an illustrative landing-page demo, show the request, the relevant source or action and the outcome. Label an illustration as an illustration. This is an application of the guidelines, not evidence that this exact marketing layout has been tested. [Human-AI interaction guidelines](https://www.microsoft.com/en-us/research/articles/guidelines-for-human-ai-interaction/)

## KasiTek capability evidence

This is a review of project documentation and source, not fresh end-to-end verification.

- [Agents README](../../../kasitek-agents/README.md) describes local agent setup, real model replies, knowledge retrieval, approved tools, website publication and inbox teammate replies.
- [End-to-end implementation plan](../../../kasitek-agents/docs/plans/agents/END_TO_END_IMPLEMENTATION_PLAN.md) records local website/inbox handoff acceptance and an internal-calendar approval followed by a persisted created-event receipt. This gives the business demo a grounded story: request a meeting, review the proposed event, approve it, see the receipt. It does not establish live external calendar-provider acceptance.
- [Runtime research](../../../kasitek-agents/docs/plans/agents/AGENT_RUNTIME_RESEARCH.md) distinguishes audience, channel and runtime. Customer, business and personal purposes should not imply three unrelated systems.
- [Personal deployments component](../../../kasitek-agents/client/apps/agent-platform/src/components/platform/personal-deployments.tsx) explicitly labels the filesystem deployment workspace as planned and says deployment controls are not available. A private hosted assistant is distinct from this future personal runtime. A personal scene must specify which experience it depicts before implying availability.

## Recommended composition

Use an editorial selector beside one large motion stage. Each row shows an audience name, a short sentence and a selected-state marker. Avoid boxed cards and a second level of Website chat / Inbox tabs. On mobile, the three compact rows sit above the stage.

| Visible category | Demo story | Graphic form |
| --- | --- | --- |
| Customer support | Return question, policy-backed answer, handoff | Existing glass messages and source card |
| Business | Meeting request, proposed event, approval, created-event receipt | Event card, review action and confirmation |
| Personal | A request using personal material, followed by a useful brief or plan | File fragments and a finished document; illustrative concept until the chosen scenario is confirmed |

All scenes use the same typeface, frame, material treatment and spacing. Each uses a different artifact appropriate to the task. Glass is the surface treatment; it does not replace the story.

Keep the stage height stable during switching, switch only on selection, animate once on entry, provide replay, and hold on the complete result. Keep keyboard selection and reduced-motion behaviour. The essential names and descriptions stay readable without waiting for an animation.

## Alternatives considered

| Approach | Tradeoff for this page |
| --- | --- |
| Three equal decorative cards | Makes the categories visible, but provides little evidence of what an agent does; also repeats a layout the owner already rejected |
| Three full-width demos stacked | Gives each audience room, but makes the Agents section dominate a page that also needs Growth and Agency |
| Small category tabs with one default scene | Compact, but makes support appear primary and hides category explanations |
| Visible descriptive selector and shared stage | Keeps the breadth visible while allowing one detailed demo at a time; recommended |

## What would validate it

Run a short comprehension check on the first version. Without explaining it, ask a visitor what Agents is for, whether it is only customer support, and which scene fits their task. Check that all three purposes are understood before interaction. Then check whether visitors can identify what the selected agent used, what it produced and where a person remained involved. Research informs this direction; those observations would test it for KasiTek.
