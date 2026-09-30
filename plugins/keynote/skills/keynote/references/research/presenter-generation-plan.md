# Plan: a generated presenter (Jack, talking to camera)

Goal: presenter shots for keynote films (24% of Apple's runtime in the WWDC25 iOS
segment) without a studio shoot for every release. The presenter is a real person,
Jack, generated from his own likeness and voice with his consent.

## Can we feed our audio and have the video match it? Yes, with the right model class

There are two different kinds of model:

| Class | Examples (Sept 2026) | Takes our audio? | Use |
| --- | --- | --- | --- |
| **Audio-driven avatar / lip-sync** | Kling AI Avatar 2.x, OmniHuman 1.5, Hedra Character-3, HeyGen Avatar V (digital twin) | **Yes.** Input is a still (or footage) plus an audio track; mouth, face and head motion follow the audio | Presenter lines: exact script, exact timing, same voice as the rest of the film |
| Text/image-to-video with generated sound | Veo 3.1, Sora 2 | No. They write and voice their own speech | B-roll and lifestyle scenes, not scripted presenter lines |

Public comparisons this year put Kling Avatar ahead on phoneme accuracy (consonants,
fast syllables), OmniHuman 1.5 ahead on gesture and body motion, and Hedra Character-3
close on lip sync but capped at 720p. HeyGen's digital twins (trained on real
footage of the person) are the most consistent across many clips. Lip sync itself is
largely solved; the remaining risks are identity drift between clips, over-animated
expressions, and gaze.

## Recommended flow

1. **Consent and inputs (Jack).** Written approval to create his digital likeness and
   voice. 15–20 photos (varied angles, neutral expression, the wardrobe we'll use) and
   2–3 minutes of clean speech. Better still, 2–5 minutes of phone video talking to
   camera in good light.
2. **Voice.** An ElevenLabs Professional Voice Clone from his recordings. The same
   voice then narrates the whole film, so presenter lines and voiceover match.
3. **Stills in our sets (image model with reference photos).** Generate Jack standing
   in each chapter's set (the same plates as the wall shots), in medium and wide
   framings, lit like the plate. Generating him *in* the set, rather than keying him
   in, keeps light and colour consistent. Pick one still per framing and reuse it
   for every line so his identity stays fixed.
4. **Talking video (audio-driven).** For each presenter line (≤ 12 s, about one
   sentence): the still + his cloned audio into the chosen avatar model gives a
   lip-synced clip. Generate 2–3 takes and keep the best.
5. **Edit.** Presenter clips enter the film as `presenter`/`clip` shots. They
   alternate with demos, as Apple does (median presenter run about 7 s), in medium
   and wide framings (a smaller face hides artifacts), graded with grain like the
   plates.
6. **Disclosure.** Label the film as containing an AI-generated presenter (YouTube
   requires disclosure of realistic synthetic people; it is also the honest thing to
   do for product marketing).

Alternative for the highest consistency: a **HeyGen-style digital twin** trained on
the 2–5 minute video (step 1), driven by script + cloned voice. It needs less
per-clip wrangling, but the set and lighting come from the training footage, so we
would film that footage against a plain backdrop and composite him into our sets.

## Test before committing (one afternoon once inputs exist)

- The same 10-second line, same still, same audio through Kling Avatar,
  OmniHuman 1.5 and Hedra. Judge lip sync on plosives, blink rate, head motion and
  identity at 1080p in the actual edit, not in isolation.
- One 3-shot sequence (wide on the wall → medium line → demo) to check continuity.
- Decide: generated stills + audio-driven model, or a digital twin, or a real shoot.

## What we need from Jack

- Consent to generate his likeness and voice, and to publish with disclosure.
- Photos and a short talking-to-camera video (phone is fine: 4K, window light,
  plain background).
- Choice of vendor account (Kling, ByteDance/OmniHuman via an API host, Hedra, or
  HeyGen). Each needs an account and API key; costs are per second of output.

Sources: [HeyGen: best talking avatar tools, 2026 test](https://www.heygen.com/blog/best-talking-avatars-video-maker),
[OmniHuman 1.5 vs Kling AI Avatar](https://piapi.ai/blogs/omnihuman-1-5-vs-kling-ai-avatar),
[Maxfusion: lip sync across leading video models](https://maxfusion.ai/blog/ai-video-models-lip-sync-2026),
[Higgsfield: making realistic lip-sync videos in 2026](https://higgsfield.ai/blog/make-ai-lipsync-videos).
