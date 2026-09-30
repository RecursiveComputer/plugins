# Session breakdown: WWDC 2025 keynote, iOS segment

Reference: the June 9, 2025 WWDC keynote, 13:06–41:30 (28:24). This is almost all of
the iOS chapter: design (lock screen, Camera, Photos, Safari, FaceTime), CarPlay,
Phone, Messages, Apple Intelligence communication features, Music, Maps, Wallet, Games,
visual intelligence, and the closing summary. The footage is studied locally, outside
the repository, and deleted after study; only measurements and descriptions are kept
here.

Method: 209 hard cuts and soft transitions from per-frame scene scores
(`experiments/footage-analysis/analyze.py`); speech pacing from word-timed captions;
a hand-labelled shot type for every 4-second sample (427 samples, 100% coverage);
10 fps strips of 11 technique windows; per-frame camera motion (`frames.py`).

## Headline numbers

| Measure | Value |
| --- | --- |
| Hard cuts / soft transitions | **209 / 3** in 28.4 min |
| Shot length | median **6.8 s**, mean 8.1 s, p10 2.6 s, p90 15.0 s |
| Speech rate | **160 wpm** while talking, 126 wpm including beats |
| Phrase length | median **4 words**, p90 9 |
| Beats (pauses ≥ 1.2 s) | 163, one every 10 s |
| Loudness | −21.6 LUFS integrated, LRA 3.4 LU (very even) |
| Presenters | **7** in 28 minutes, each in their own location |

### Shot mix (share of runtime)

| Shot type | Share |
| --- | --- |
| Device render: the product UI on a device, full frame | **30.2%** |
| Presenter to camera (studio or location) | **23.9%** |
| Wide: presenter beside the video wall | 17.1% |
| Full-frame graphic (title, icon, list, bento, flat UI) | 12.6% |
| **Real hands on a real device** (macro inserts) | **10.5%** |
| Lifestyle / product-in-world b-roll | 5.2% |
| CG scene transition | 0.5% |

**The product is on a device 41% of the time** (renders plus hands). Flat,
frameless UI appears only as short graphic crops (e.g. a zoomed Calls list), well
under 5%. A person is on screen in 41% of shots (presenter plus wide). Our v6 film
has 0% presenter, 0% real devices and a drawn laptop.

## The feature unit (repeated about 25 times)

Every feature follows the same sequence, and every app block wraps its features the
same way:

1. **Chapter marker on the wall.** Wide: the presenter stands beside the freestanding
   wall showing one app icon and its name on white. A single icon is the whole slide.
2. **Why it matters.** Presenter medium, one sentence placing the app in daily life,
   then a concrete, relatable pain (stuck on hold, spam, a group chat that can't
   agree on a weekend).
3. **Name it once.** The feature name is spoken as a noun phrase. The same words
   appear on screen beside the device ("Unified layout", "Call Screening",
   "Hold Assist"). Script and graphics share one vocabulary.
4. **Show it on the device.** A device render on a blurred plate of the presenter's
   own set, narrated as behaviour ("when X happens, it does Y"), not as UI parts.
5. **Human proof (major features only).** A 10–25 s lifestyle vignette: a real person
   in a real place using the phone, with the screen readable.
6. **Developer beat.** One line tying the feature to an API, often with the API's
   icon full-frame.
7. **Section recap.** The last device pulls back into a 3-device lineup, with the
   feature labels listed beside it (the same labels shown earlier), then a cut to
   the wide with the same card on the wall.
8. **Handoff.** The wall content slides sideways to the next app's icon, or the host
   names the next presenter, who opens in a new location.

## Messaging and script

- **Promise first, in threes.** The chapter opens by naming three kinds of
  improvement, then "let's dive in". Recaps come back in threes as well.
- **Pain before feature.** Almost every feature starts from a specific, slightly
  funny, universal annoyance, and the feature is framed as getting time or attention
  back.
- **Behaviour, not interface.** Features are described as what the product does for
  you over time (it waits, it answers, it rings you back), rarely as buttons.
- **First person in demos, second person in benefits.** "I'll switch…" while the hand
  or cursor acts; "you" when stating the outcome.
- **One number per section, at most.** A usage figure establishes scale at the top of
  a block; stats never stack.
- **Trust at the point of doubt.** Privacy and control lines arrive exactly when an
  AI feature could raise concern (on-device, nothing shared without permission).
- **Before and after in the narration.** "From this… to this" lines play over the
  screen changing state, so the words and the picture land together.
- **Handoffs are one line.** "To tell you more, here's …" / "back to …". No
  transitional filler.
- **Pace.** Short phrases (median 4 words) at 160 wpm with a beat every 10 s. Speed
  comes from density, and the beats give the picture room.

## Presentation

- **Host plus specialists.** The host opens and closes the chapter and returns
  between blocks. Six specialists each own one area, and each has their own
  location. The name and title lower third fades in about 3 s after they settle,
  never on the first frame.
- **Presenters hold the product.** In the design section the host holds the iPhone
  while talking, then the edit cuts to macro inserts of his hands using it. Speaking
  and demonstrating are one continuous act.
- **Marks and walks.** On wides, presenters walk between marks beside the wall.
  Mediums are static, and the camera trucks to follow a walk.
- **Demos are staged, not screen-recorded.** Device renders are clean and animated
  exactly on the words; hands-on inserts are shot practically.

## Set design

- **One location per presenter**, all real architecture: a timber-ceilinged atrium
  with curved white walls, a white studio with a plant and a sofa (hands demos), a
  glass terrace with trees, a courtyard with an oval opening, a garden of glass
  reeds, a white curved room, and a road with the car for CarPlay.
- **The video wall** is freestanding, frameless and luminous white with softly
  rounded corners, sitting on the floor. Its content is minimal: one icon and name,
  an icon grid, one device, a title, or the recap card. It is a chapter marker, not a
  second screen for the demo.
- **Device plates belong to the set.** Device renders sit on a heavy blur of the
  current presenter's location (trees and sky for the terrace, white for the studio),
  so a cut from presenter to device keeps colour and light continuous.
- **Palette discipline.** Sets are neutral (white, timber, green, sky); all saturated
  colour comes from the product UI and icons.

## Cinematography

- **Wides are locked or drift slowly.** The camera trucks across the wide while the
  presenter talks (measured below), and pushes in to the wall before a cut to its
  content.
- **Wide and medium share the wall.** Mediums are framed so the wall's content (a
  feature title) is still visible, huge and cropped at the top edge. The medium
  carries the same words as the wide.
- **Hands inserts** are macro, shallow depth of field, off-white seamless background,
  soft top light, slight handheld float, and the screen exposed so the UI reads.
- **Device renders** are frontal and mostly untilted, centred or placed opposite the
  label. When detail matters, the device pushes in fast until the UI fills the frame.
- **Deep focus in sets, shallow only in inserts and plates.**
- **Measured motion profile.** The per-frame detector finds 351 global motions (172
  pans/drifts, 100 push-ins, 79 pull-outs). It counts UI animating inside full-frame
  device shots too, so treat the counts as an upper bound on camera moves. Duration:
  median 0.57 s (p10 0.3, p90 2.0). Velocity peaks at a median **35%** of the move
  (p10 10%, p90 71%): the same fast-attack, long-settle curve measured in the WWDC26
  study, which our `keynoteEase` already fits.

## Motion graphics

| Element | Behaviour (from 10 fps strips) |
| --- | --- |
| Icon grid → subset | Cut from the wall to the full-frame grid; irrelevant icons fly outward past camera with depth blur (~0.5 s) while the relevant ones regroup larger, then hold with a slow drift |
| Device entrance | Hard cut in; the device holds still ~5 s; a fast push (~0.3 s acceleration) into the screen when the narration reaches the detail |
| Feature label | Black, two lines max, beside the device; cuts in, no build |
| Feature title | Blue-to-teal gradient type on the blurred plate, held ~3.7 s. Used only for headline features (Call Screening, Live Translation, Order tracking) |
| Section recap | Single device pulls back and new devices slide in (~0.5 s) to a 3-device lineup plus the label list; hold ~3 s; cut to the same card on the wall |
| App → app | Wall content slides sideways (~0.5 s): the next icon enters from the right and its name fades in under it |
| Developer / privacy beat | The logo becomes a padlock (morph), then the API icon |
| Finale | Chapter wordmark tile brightens in the centre; bento tiles build outward, staggered (~1.2 s); hold ~6 s with a slow push |

Motion only happens when it explains a relationship: narrowing to a subset, zooming to
a detail, grouping features into a recap, or moving to the next app. Everything else
cuts.

## Transitions

- **Cuts are the default:** 209 cuts against 3 soft transitions in 28 minutes.
- **Continuity cuts:** wall wide ↔ the same graphic full frame; title full frame ↔
  medium with the title on the wall behind. The cut changes framing, never content.
- **Portal moves only at location changes (0.5%).** (a) Push into the wall until the
  CarPlay icon fills the frame, continue into the icon's glass play symbol, and its
  refraction reveals the road where the next presenter stands. (b) Tilt up from a
  garden into the sky, then down through a circular skylight into the next room; a dot
  on the wall grows into the Games icon as the presenter comes into frame. Both run
  about 4–7 s and use the product's own material (glass) or a shared element (sky).

## Devices: what "real device" means here

Three device modes carry 41% of the runtime:

| Mode | Share | What it is | How we get it |
| --- | --- | --- | --- |
| Frontal device render on a blurred set plate | 30% | Photoreal device model, straight-on, UI animated in the screen, soft contact shadow | Accurate device model with our 2× capture as the screen; Blender, or frontal compositing for untilted shots |
| Hands on a real device | 10.5% | Macro of real hands using a real phone or laptop | Film real hardware running the seeded demo; the screen is live, or a tracked replacement with our capture |
| Device on the wall / in a lineup | (within wide + recap) | The same renders placed on the wall or grouped | Reuse the renders |

Constraints on using Apple's own device images:
- Apple's official product bezels (Apple Design Resources: Photoshop/PNG for iPhone,
  iPad, Mac, Watch) are for showing *your app* on the devices it supports. The marketing
  guidelines require the images be used as is: no reflections or shadows added, no
  cropping or tilting, and no animating, flipping or spinning. Copy goes beside the
  device, never on top. For video, start with the app open, and after an establishing
  shot of the whole device you may pan and zoom to the app, using simple fades or
  dissolves.
  - So official bezels suit **static end cards and frontal shots with pan/zoom**, not
    orbiting 3D moves.
  - The licence is tied to Apple Developer Program membership and to apps available
    through Apple's store. Confirm which of our apps qualify before using bezels (the
    iOS app likely does; check the Mac app).
- Orbiting and tilted device shots need our own 3D device models. Using third-party
  models that reproduce Apple hardware exactly raises trade-dress questions, so get a
  legal read before publishing. The most defensible "real device" footage is
  **filming actual hardware** running our app.

## Gaps against our v6 film

| Dimension | Apple (measured) | Our v6 | Change |
| --- | --- | --- | --- |
| Product on a device | 41% | Drawn CSS laptop | Real device renders + hands inserts |
| Presenter on screen | 41% of shots | 0% (VO only) | A real person (see production plan) or accept VO-only |
| Wall content | One icon + name, or one device | Full UI and stat cards | Icon, device or title only |
| Feature label | Same words spoken and shown, beside device | Words shots and captions | Label beside device |
| Section recap | After every app block | Once at the end | Per-chapter lineup + list |
| Locations | One per presenter | One generated courtyard | Distinct plates per chapter |
| Device plate | Blur of the current set | Off-white paper | Blurred set plate |
| App-to-app | Wall slide / portal | Cut or through | Wall slide; portal only between chapters |
| Numbers | ≤ 1 per block | Several stats | One per chapter |

## What to build next (in order)

1. **Device renders** (`device` shot): a photoreal phone and laptop model, frontal
   by default. Screen = 2× capture as an emissive texture with correct gamma and a
   glass reflection pass. Blurred set plate behind, label beside, push-to-screen,
   3-device lineup and recap build. Blender renders the device layers once per camera
   path; the capture is applied at render time.
2. **Hands shoot:** film the seeded demo on a real iPhone and MacBook. Macro on a
   seamless, soft top light, 4K60 log, with the screen exposed for the UI. Screen
   replacement is only needed when the live screen can't be exposed well.
3. **Wall grammar:** an icon-plus-name card, a device-on-wall card, and the
   app-to-app slide.
4. **Feature title and label styles:** gradient headline title (used sparingly) and
   label-beside-device.
5. **Per-chapter recap build** and a closing bento.
6. **Script template:** a feature unit with pain → name → behaviour → proof →
   developer beat → recap, with the lint enforcing one number per chapter and shared
   label vocabulary.
