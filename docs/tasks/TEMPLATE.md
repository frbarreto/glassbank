# <id> <slug>

Status: open
Block: <block>

Goal: one sentence.
Inputs: contracts version, fixtures, fakes, related docs (cite `A-xx`, `D-x`, `ADR-x` where relevant).
Paths you may edit: `src/<block>/**`, `docs/blocks/<block>.md`. Everything else is read-only (`src/contracts/**`, `src/app.ts`, `src/composition.ts`, `package.json`, `CLAUDE.md`, other blocks' directories).

Deliverables: code, tests, `docs/blocks/<block>.md` sections.
Events: event types owned or emitted.
Assumptions touched: A-xx ..., D-x ..., ADR-x ...

Definition of done: `npx vitest run src/<block>` and `npm run check` green; block doc updated (Status, Public interface, Events owned, How to test, Known gaps); no TODO referencing another block's code; proposals appended to `docs/contracts/CHANGES.md`; a `THIRD_PARTY_NOTICES.md` line for every copied Ramp fragment.
How to verify: exact commands.
Forbidden: for example "no new npm dependency without a `docs/DEPENDENCIES.md` line", "no gcloud flag outside `infra/deploy.sh`", "no SQL on the main event loop".
