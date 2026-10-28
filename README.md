# OOCM Campaign Autopilot

A business pastes its website. Meta's models run the whole creator campaign: they write the brief, choose creators, and check every draft video against the brief, with proof, before the brand sees it.

OOCM ([outofcontextmarketing.com](https://outofcontextmarketing.com)) is a live creator-marketing platform. This repository holds **only the code written during the Meta Global AI Developer Hackathon (27 Oct to 4 Nov 2026)**. It plugs into OOCM's existing product, which was built before the event and is not part of this submission.

## What was built during the hackathon

| Part | Meta models | File |
|---|---|---|
| Meta Model API client: Responses with JSON schema, Files, Voice Transcribe, SAM 3.1 | all | `src/meta/client.ts` |
| Draft checker: watches the creator's video and checks it against the brief, with seconds, quotes and tracked frames as evidence | Muse Spark 1.3, Muse Voice Transcribe, SAM 3.1 | `src/draftCheck/check.ts` |

More parts land here as they are built (brief writer, creator fit by watching, open-weight lane, eval harness).

## How the draft checker decides

1. **Watch.** Muse Spark 1.3 reads the video's frames and soundtrack together with the brief, and answers every check with the second it happens and the words used.
2. **Listen.** Muse Voice Transcribe writes down what is said, independently. It is primed with the brief's brand names and codes (`keywords`), so "DEW10" is not heard as "DU10".
3. **Locate.** SAM 3.1 tracks the product through the video, so "product on screen" comes with frame-accurate boxes.
4. **Verify.** A second, text-only Spark call reads the transcript and must copy the exact words that prove each line was said. The excerpt is then checked against the transcript in code. This works across scripts: an English brief line is proved by Hindi words.
5. **Decide.** A verdict passes only when two independent sources agree. When they disagree, the item goes to a person ("needs review") instead of guessing.

## Run it

Needs Node 22.18+ (runs TypeScript directly) and ffmpeg.

```bash
export META_MODEL_API_KEY=...
node scripts/check.ts path/to/draft.mp4
```
