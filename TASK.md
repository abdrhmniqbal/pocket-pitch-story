Fix throw-in issues in src/engine/matchEngine.ts:

PROBLEM 1: Opponents stay too close to the thrower (no retreat logic exists for throw-ins).
PROBLEM 2: The thrower keeps changing (likely re-triggered when taker is pressured).

FIX 1 - Opponent retreat during throw-in setup:
In updateSetPiece, add a throw_in branch (similar to existing corner_kick/goal_kick branches around line 895). During throw-in preparation:
- All OPPONENTS (team !== sp.team, not GK, not sent off) must stay at least 80 units from sp.spot. If closer, steer them away to a point 80+ units from the spot (push them infield, not toward the touchline).
- Use steerPlayerTo with setPieceRunSpeed, set state to 'running'.
- This gives the thrower space to execute.

FIX 2 - Taker stability:
- Once setupSetPiece picks a throw-in taker, do NOT re-pick unless the taker is sent off or the set piece is cancelled.
- Check if there's any code path that calls setupSetPiece again during an active throw-in (e.g. if ball is touched). If so, guard it: if sp.type === 'throw_in' and sp.kickerId is still valid, keep the same taker.
- Also ensure opponents cannot tackle the taker during the walk-up phase (similar to throwInGrace but for the setup phase).

Do NOT change: other set pieces, open play, celebration logic.
Verify: bun run lint, bun run build. Sim: throw-ins complete without taker switching.
Commit when done.

---
Orchestrator rules (do not violate):
- This is a non-interactive run. If you need clarification, STOP and reply
  with a line starting NEEDS_INPUT: followed by the exact question.
- Your working directory is /home/hatch/workspace/game-assets/gemini-pocket-league. Work only inside that exact absolute path; never write to /home/hatch or any other location. Do not read, write or run
  commands touching files outside it.
- Never read .env files, credentials, keys or tokens, and never print
  secrets. Do not use the network except package registries the task
  explicitly needs.
- Do not send messages, publish, deploy, purchase, or modify any external
  account or service.
- Finish by listing: files created/changed, how you verified the work,
  and anything left undone.
