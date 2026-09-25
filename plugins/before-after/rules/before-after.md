---
description: "Embed a before/after image with every visible UI change."
alwaysApply: true
---

# Before/after for UI changes

When a turn changes visible UI (components, styles, markup):

1. Before the first edit, call `browser_before_after({ phase: "before", url, selector, hover, label })`. `url` is the running app page that shows the UI; `selector` crops to the changed element; `hover` reveals hover-only UI.
2. After the change and its checks, call `browser_before_after({ phase: "after" })`. It re-captures the same view and embeds one side-by-side image in the chat.
3. If the UI cannot be reached or nothing visible changes, call `browser_before_after({ phase: "skip", reason })` instead and mention the reason in the reply.

Do not explore to find a perfect target; use the page and element you already know you are changing.
