# Transition anatomy (frame by frame)

Every frame (29.97 fps) of four animated transitions from the WWDC 2025 iOS segment
(see `session-breakdown-wwdc25-ios.md`), plus a 10 fps read of two more. Times are
seconds into the studied clip. The zoom curve was measured from the icon's area on
every frame.

## The principle underneath all of them

**The camera moves through one continuous space; graphics mostly hold still in it.**
Recaps, walls and titles are laid out as static compositions, and the camera reveals
them. Things animate on their own only when the animation *is* the idea: a set
narrowing to a subset, a feature leaving its icon. When two spaces must connect, the
camera travels through something they share: the product's own material (a glass
glyph), or the sky.

## 1. Portal: wall icon → new location (CarPlay handoff, 309.0–313.9)

| Phase | Time | What happens |
| --- | --- | --- |
| A. Approach | 309.0–311.4 | Wide of the presenter at the wall. The camera pushes toward the wall's single icon; the presenter walks out of frame right. The wall's edges leave frame at 311.4. |
| B. The icon comes alive | 311.8–312.6 | The icon's arc detaches as a 3D glass ring and swings forward past the camera (lower left). The icon and its label keep scaling together, as one plane. |
| C. Destination inside the glyph | 312.6–313.2 | The push enters the glass play triangle. Through its refraction you already see the next location, blurred and distorted: road, car, presenter. |
| D. Crossing the glass | 313.2–313.45 | The triangle fills the frame. Its edge sweeps across with heavy refraction, and the green icon body exits at the corners. |
| E. Landing | 313.45–313.9 | The location starts slightly defocused and sharpens in about 0.3 s. The forward motion carries over and eases to a stop. The lower third arrives about 3 s later. |

**Measured zoom** (icon linear size, log scale): zoom velocity rises smoothly from about
0.05/s at 309.0 to 0.35/s at 311.5 and about 1.0/s at 312.5. That is an
**accelerating push, about 20× faster at the end than at the start, with no slowdown
before the handoff**. The deceleration happens in the destination shot, so speed
matches across the glass.
Rule: *ease-in on the source, ease-out on the destination, match velocity at the seam.*

## 2. Icon grid → the subset being discussed (10.1–11.4)

- 10.14–10.60: full-frame grid of 18 icons (cut from the wide of the same grid on the
  wall), holding with a barely visible push.
- 10.64–11.10 (**~0.45 s**): layout reflow. The 7 icons in scope slide to a new 4 + 3
  arrangement and grow about 1.3×. The others travel outward toward the nearest edge
  and leave frame; there's no fade in place. Paths are straight, all moving at once, ease-out.
- 11.10–11.40: settle; the slow push continues.

Rule: *narrowing is shown as survivors regrouping, not as others disappearing.*

## 3. Section recap: one device → lineup + labels (633.2–634.2)

- 633.2–633.43: the single device (the last demo) starts to shrink and drift right.
- 633.43–634.0 (**~0.6–0.8 s**, ease-out): the camera pulls back and pans across a
  **static** composition. The label list (the three feature names used earlier) enters
  from the right *because the camera moves*, not through its own animation. The second
  and third devices enter from the left the same way.
- 634.0 onward: hold about 3 s, then cut to the wide showing the same composition on
  the wall.

Rule: *a recap is a pull-back that reveals everything you just saw, side by side.*

## 4. App → app on the wall (639.4–641.0)

- Locked-off wide. The wall's content slides left as one strip (**~0.5 s**, ease in-out):
  the current app icon exits left and the next enters from the right.
- The next app's name fades in under its icon over about 0.3 s after the slide settles.

Rule: *moving to a sibling is a lateral move; the space implies the apps sit side by side.*

## 5. Sky → skylight (location change, 1321.0–1333.0, 10 fps)

- 1321.0–1323.0: the camera tilts up from a presenter in a garden into the sky,
  accelerating.
- 1323–1324.6: sky only. This is the shared element.
- 1324.6–1326.6: the sky becomes a circular skylight in the next room's ceiling, seen
  from inside. The camera keeps tilting, now downward, into a white curved room.
- 1327.7–1329.0: a dot on the far wall grows into the next chapter's icon on the video
  wall as the new presenter comes into frame. The move settles, and the lower third
  follows.

Rule: *join two locations through something both have; never dissolve between them.*

## 6. Finale build (1691.4–1693.5)

- Cut to white. The chapter wordmark tile brightens in the centre (about 0.7 s).
- Feature tiles build outward from it, staggered (about 1.2 s), into a bento.
- Hold about 6 s with a slow push, then cut to the presenter framed with the bento on
  the wall.

## Durations cheat sheet

| Transition | Duration | Curve |
| --- | --- | --- |
| Layout reflow (grid → subset) | 0.45 s | ease-out, simultaneous |
| Recap reveal (camera pull) | 0.6–0.8 s | ease-out |
| App → app slide | 0.5 s + 0.3 s label fade | ease in-out |
| Device push to screen detail | ~0.3 s acceleration | ease-in, hard stop by cut |
| Portal (wall-filling → landed) | ~2.7 s (4.5 s including approach) | ease-in to the seam, ease-out after |
| Sky/skylight location change | ~7 s | continuous tilt |
| Finale bento build | ~1.9 s | stagger outward |

## How we reproduce them

| Transition | Stage implementation |
| --- | --- |
| Reflow | Items keyed by id in two layouts; kept items tween position and scale (0.45 s, critically damped spring); removed items translate radially off-frame with motion blur |
| Recap reveal | Render the lineup + labels as one static layer; animate only the camera (pull + pan, 0.7 s, `keynoteEase` out) |
| App slide | Wall content is a horizontal strip of icon cards; translate by one card width; label opacity after settle |
| Portal | Wall push with an accelerating zoom (exponential in log-scale). The glyph is a masked layer that shows the destination frame through a displacement (refraction) filter; hand off at matched zoom velocity, then the destination eases out from a 1.06× scale with a 0.3 s defocus-to-sharp |
| Location join | Needs two plates that share an element (sky); a tilt-up and tilt-down pair with a cut hidden in the sky-only frames |
