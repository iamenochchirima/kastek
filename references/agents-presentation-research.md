# Presenting the Agents product

Researched 2026-10-11. This brief informs a design decision; it does not change the landing page.

## What the first-party references show

The useful distinction is between an audience, a job, and a product. The sites below often keep one product promise, then explain particular jobs through examples. None establishes that Labs must split its three audiences into separate products.

| Reference | Evidence from the live page or its first-party content | Lesson for Labs, an inference |
| --- | --- | --- |
| [Lindy](https://www.lindy.ai/) | Browser observation: a centred hero, integration icons around its perimeter, and a Slack-style demo below. The demo starts with a request about increased ad spend and shows the agent reading named sources. Extracted page content also contains task steps, result documents and actions to open or review results. | Give the agent something understandable to do. A request, its relevant context and a visible result explain more than moving bubbles alone. |
| [Lindy executive assistant](https://www.lindy.ai/hire/executive-assistant) | Textual observation: examples are named by task, including planning a week, preparing a meeting and finding a time. The page shows calendar options and an explicit booking question, with separate actions to book or explore another week. | A personal scene can have a calendar or plan as its result. It need not imitate customer support. Use an approval moment where that is how our product works. |
| [Fin customer agent](https://fin.ai/customer-agent) | Browser observation: a central orange sculptural mark is surrounded by related coloured forms. Textual observation: the page presents one customer agent playing service, sales and ecommerce roles, then describes those roles individually. It distinguishes the customer-facing agent from its internal Operator. | Keep the common Agents identity. Distinguish whom the agent helps and what it does, without suggesting each category is a separate technical platform. Abstract art can introduce a brand, but the role examples still have to explain the work. |
| [Dust](https://dust.tt/home) | Browser observation: the hero uses coloured isometric team shapes, people and an overlaid conversation. Textual observation: the page describes shared company knowledge, connected tools and human review. Further down it offers department choices including support, sales and engineering. | Business work should show company context and a person directing or reviewing it. A broader composition can communicate people and tools working together without showing a full dashboard. |
| [Microsoft agents](https://www.microsoft.com/en-us/copilot/resources/agents) | Textual observation: the page groups examples around productivity and operational work, then gives agents clear task descriptions, including research, analysis, sales qualification and account reconciliation. | Keep audience labels simple and supplement them with a concrete example. A category name alone leaves visitors guessing what happens. |
| [Relevance AI](https://relevanceai.com/) | Textual observation: the page names specialist jobs, including pre-meeting preparation, contract review and invoice matching. It groups examples by business function and discusses choosing initial use cases before deploying them. | Prefer a small, representative task that we can substantiate. Avoid presenting an unspecified business agent as capable of everything. |

Browser screenshots are reference captures, not complete audits of every interactive state. Text extraction and the rendered page can differ because pages change, content is personalised or animations load in stages. The observations above distinguish the evidence used. These examples do not prove that a particular layout converts better.

## Recommended direction for the Labs section

Use one Agents section with three visible category choices and one large visual stage. Keep a short description beside every choice, so a visitor understands the range before clicking. Let selection change the example manually. Customer support should no longer be the only story, and Website chat versus Team inbox should not remain the primary navigation across this whole section.

The current glass animation can become the support scene. Carry its typography, materials, lighting and motion pace into the other scenes, while changing the objects and the result.

| Category | Candidate story to verify against Labs capabilities | Composition |
| --- | --- | --- |
| Customer support | Customer question, relevant knowledge, grounded answer, handoff when needed | Conversation in the foreground, a readable source card behind it, human handoff as the final beat |
| Business | Internal request, relevant business context, proposed action, approval, recorded result | Request card and source cards lead to one action or result card; keep the person’s decision visible |
| Personal | Individual request, relevant personal context, proposed plan or helpful result | A quieter composition with a personal request and a plan or calendar result, rather than a team inbox |

These are storyboard candidates, not product promises. Select actual supported tasks before writing the finished demo. In particular, a private hosted assistant and a personal agent running on someone’s device are different claims.

Animate changes that explain the task. Show which source informs the answer, what action is proposed and what result arrives. Use glass depth and reflections to support those changes. Keep the request and final result readable, let the sequence finish, and provide replay. Avoid perpetual motion that makes visitors chase the text.

The design decision still needs a focused comparison. Prototype the same verified stories in two arrangements: visible category rows beside one stage, and three short stacked scenes. Compare category visibility, mobile reading, how much scrolling the whole Labs page gains and whether the work is understandable without playing the animation. The competitor pages supply examples; this comparison will tell us what fits our own page.

## Layout decision and project evidence

See the [layout decision note](agents-presentation/README.md) for UX research, local capability evidence, saved desktop screenshots and the proposed comprehension check. The initial recommendation is visible descriptive rows beside one stage; a stacked alternative remains a comparison candidate if mobile testing shows the selector obscures the breadth.
