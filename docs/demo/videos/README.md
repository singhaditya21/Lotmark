# The demo films

Seven narrated films of the console, about ten and a half minutes in total.
Each is 1920×1080 H.264 with AAC narration, captions burned into the picture,
and a `.srt` beside it carrying the same words as subtitles.

Every film opens on a card naming the journey it follows and the features it
passes through, so a viewer who watches ten seconds still knows what they were
about to be shown.

| Film | Length | The journey |
|------|--------|-------------|
| [main](lotmark-main.mp4) | 3:03 | One material end to end — certified under signature, sold to a laboratory, broken by a cold-chain excursion, withdrawn, and proved to an assessor |
| [people](lotmark-people.mp4) | 1:26 | Authority, competence and membership are three different things, and all three are needed |
| [lowcode](lotmark-lowcode.mp4) | 1:27 | Fields, forms and workflows are designed in a draft and published under signature |
| [assessor](lotmark-assessor.mp4) | 1:27 | Conformance reported from the records, not from a specification with ticks beside it |
| [customer](lotmark-customer.mp4) | 1:00 | The buyer's half — catalogue, order, tracking, the certificate vault, price tiers |
| [onboarding](lotmark-onboarding.mp4) | 1:04 | An account's life: created, enrolled, granted authority, revoked |
| [wayfinding](lotmark-wayfinding.mp4) | 1:01 | Land on your own work, and jump to any record by the code somebody quoted |

Every frame is the real console — the published demo at
<https://singhaditya21.github.io/Lotmark/> — driven through its own screens.
Nothing is mocked up, and no frame is hand-edited.

## Re-recording them

```bash
pnpm demo:films              # all seven
FILM=customer pnpm demo:film # one of them
```

The narration and the click-path it describes live together in
[`tools/video/beats.mts`](../../../tools/video/beats.mts), so they cannot drift
apart: each beat is spoken by a local text-to-speech pass, measured, and then
the picture is held for exactly that long. Editing a line and re-rendering a
film takes a couple of minutes.

See [`tools/video/`](../../../tools/video) for how the pipeline works, and
[`../shot-list.md`](../shot-list.md) if you would rather record a take by hand.
