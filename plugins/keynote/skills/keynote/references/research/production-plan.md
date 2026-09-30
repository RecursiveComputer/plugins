# Keynote production plan: what comes next, and why

## 1. Synthetic presenters (people speaking to camera)

**Capability (Sept 2026).** Short clips with synced speech are feasible:
Sora 2 (developer API) is strongest at lip-sync on prompted dialogue, and Veo
3.1 at ambient audio. Both are clip-length (around 8 s), vary between
attempts, and often need several regenerations. Avatar platforms (HeyGen and
similar) do longer, stable talking heads, including digital twins of a real,
consenting person.

**Recommendation: no invented people.** A made-up "employee" announcing our
release misrepresents who is speaking, and viewers who notice stop trusting
the rest of the film. Options in order:
1. A real person (founder or team) filmed on a phone against a real space.
   The pipeline already takes presenter plates.
2. A clearly disclosed digital twin of that real person, from their own
   footage, with their consent.
3. No presenter: VO over sets, demos and graphics. This is the current film,
   and Apple's own product films work this way.

## 2. Recapturing the app (Apple-grade demo footage)

Current captures are 1× browser viewports with dev data and no desktop.
Recapture spec:

| Aspect | Spec |
| --- | --- |
| Resolution | `deviceScaleFactor: 2` (2880×1800 for a 1440×900 window) so pushes and close-ups stay sharp |
| Desktop | App window on a real desktop wallpaper (our own brand wallpaper), window about 80% of the screen, soft shadow; a few "hero" shots full-screen |
| Data | Seeded demo workspace: believable project names, no internal reminders, no personal paths |
| Flows | 30–90 s stories (reason → action → result → second beat), not 6–18 s gestures |
| Holds | 1.5 s clean hold before the first action and after the result (edit points for pushes) |
| Stills | Clean flat screenshots of key states for device mockups and end cards |
| Mobile | Same seeded data on iOS at native resolution for phone mockups |

Needs a checkout-owned dev server and a seeded workspace: never the installed
app or live data.

**Implemented:** `websites/recursive/scripts/keynotes/capture/` records story
flows from the seeded homepage demo at 2880×1800, 60 fps, on Chrome virtual time
(every frame lands exactly, however slow capture is). It writes release-format
telemetry, 2× stills and a desktop version: the window on a generated glass wallpaper
with menu bar and shadow, at 3840×2400. The mobile shell renders at native
iPhone resolution for phone mockups. See its README for seed coverage and gaps.

## 3. Camera moves

Keynote product moves are **motion-control or stabilised physical moves** with
real parallax: slow dollies around a device, a crane rising over a set, a
device rotating to show its screen. Our 2.5D moves (zoom on a plate, push into
a flat wall) cannot rotate around an object. That is why they read as
"digital".

**Implemented:** `experiments/devices/` renders photoreal generic phone and laptop
models in Cycles, as beauty + UV passes. Any footage is composited onto the screen
afterwards, over a blurred plate of the chapter's set, with a label beside the device.
The end card takes a real-device `lineup` image instead of drawn frames. Original plan:

Next step: **device shots in Blender.** Generic laptop and phone models (no
Apple trade dress), with the recaptured app on the screen as an emissive
texture, studio lighting on the off-white infinity, and keyed camera paths:
orbit-and-settle, rise-and-reveal, slow push. Render with motion blur and
depth of field. Use them for the "show" beat before the full-screen demo, and
for the end card.

## 4. End cards

Implemented: `endcard` with `devices: { laptop, phone }` and `availability`
shows the product on devices over the off-white field, with the version and
availability line ("Available now · August 3, 2026"). It is static.

## 5. How Apple's pre-recorded keynotes are shot (public sources)

From Apple Newsroom and trade coverage of the October 2023 "Scary Fast" event:
- **Cameras:** iPhone 15 Pro Max for all presenters, locations and drone
  shots; Blackmagic Camera app; Apple Log; ProRes up to 4K60 recorded to
  external SSDs; the 24 mm main camera at 59.94 fps.
- **Support and grip:** SpaceCam gyro-stabilised rig, DJI RS 3 Mini gimbals,
  dollies, cranes, drones, Beastgrip cages.
- **Sync and monitoring:** Tentacle Sync timecode across every device, Macs for
  monitoring and review on set.
- **Look:** heavy professional lighting, deep depth of field (sharp
  backgrounds), grading at Company 3.
- **Post:** edited and finished on Mac.

Sources: [Apple Newsroom: Behind the scenes at Scary Fast](https://www.apple.com/newsroom/2023/10/behind-the-scenes-at-scary-fast-apples-keynote-event-shot-on-iphone/),
[CineD](https://www.cined.com/behind-the-scenes-of-apple-event-shot-on-iphone-15-pro-max-a-sign-of-things-to-come/),
[No Film School](https://nofilmschool.com/apple-event-video).

Implications for us: the camera always moves on a stabilised path (gyro head,
gimbal, crane, dolly), never handheld; the look relies on light and deep focus,
not shallow-focus blur; a single camera system keeps colour consistent.
