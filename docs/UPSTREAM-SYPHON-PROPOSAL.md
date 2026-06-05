# Upstream proposal: a frame-synchronized / caller-owned surface path for Syphon

> **Status:** research note, addressed to the [Syphon-Framework](https://github.com/Syphon/Syphon-Framework) maintainers.
> Nothing here is needed to *use* electron-syphon — the library is at its measured floor on the current
> API (see [`METHODOLOGY.md`](../METHODOLOGY.md) §10). This documents the *only* two remaining
> speedups we measured, both of which are blocked at the framework boundary, so they can be filed
> upstream rather than re-investigated locally each time.

## TL;DR

The Metal publish path has exactly two costs left that we cannot remove from the consumer side:

1. **One full-frame copy per published frame** (`publishFrameTexture:` explicitly *"copies"* the
   texture). For a producer that already owns a shareable `IOSurface` — e.g. Electron's offscreen
   shared-texture path hands us an `IOSurfaceRef` directly — this copy is redundant: we are copying one
   `IOSurface` into the server's *own* `IOSurface`.
2. **No writer/reader synchronization.** Syphon publishes into a single server-owned surface with no
   keyed mutex, so under load a client can sample a half-written frame, and a zero-copy single-surface
   producer cannot be made tear-safe by double-buffering (the subclassing API exposes only one surface).

Both have the same root cause — **the server owns and recycles exactly one `IOSurface`, and the only
way in is a copy** — and both would be addressed by one of the two API additions below. Spout (Syphon's
Windows twin) already solves #2 with a keyed mutex on its shared texture; this is the macOS gap.

## Evidence from the shipping headers

- `SyphonMetalServer.h` — `publishFrameTexture:onCommandBuffer:imageRegion:flipped:`:
  *"The texture is **copied** and can be safely modified once this method has returned."* → the one copy.
- `SyphonSubclassing.h` — `newSurfaceForWidth:height:options:`:
  *"returns **an existing or new** IOSurface sized for the given dimensions"* (one cached surface per
  size; re-asking the same size returns the *same* surface), and `-publish` advertises *that one
  surface*. There is no publish-by-surface call → a server holds exactly one surface at a time → no
  tear-safe double-buffering is possible through the documented API.
- The only server option today is `SyphonServerOptionIsPrivate`.

## What we measured (so the ask is grounded, not speculative)

Live on Apple silicon, current `main` (`npm run bench`, `npm run bench:scaling`):

- Single-window zero-copy publish (async submit): **0.070 ms/frame at 1080p** — flat to ~2 MP, then
  purely memory-bandwidth-bound. The residual is the one copy + command-buffer submit.
- Composite wall, `direct` render-into-server-surface backend: **2.3–2.6× faster than the copy-based
  atlas backend**, and it sits ~at the theoretical 1-blit ceiling — *but it ships as opt-in*, because
  its single shared surface is not tear-safe (exactly the synchronization gap below).

So the copy and the missing sync are not micro-costs we *hope* matter — they are the two things that
(a) keep single-window above 0 copies and (b) keep the 2.5× backend from being the safe default.

## Proposal A — publish a caller-owned / rotating `IOSurface` (removes the copy)

A server entry point that advertises an `IOSurface` the **caller** owns, instead of copying into the
server's own surface:

```objc
// SyphonSubclassing (or SyphonMetalServer) addition — illustrative:
- (void)publishSurface:(IOSurfaceRef)surface
                 valid:(BOOL)isValid;      // caller guarantees the surface is finished being written
```

or, to keep Syphon's "server owns the surface" invariant while still allowing rotation, let the server
vend **N** surfaces and publish by index:

```objc
- (IOSurfaceRef)surfaceAtIndex:(NSUInteger)i count:(NSUInteger)n
                         width:(size_t)w height:(size_t)h;   // one of n rotating surfaces
- (void)publishSurfaceIndex:(NSUInteger)i;                   // advertise the one just finished
```

- **Removes the copy** for producers that already hold a shareable surface (Electron OSR, any Metal
  app rendering into an `IOSurface`-backed texture).
- **Unblocks tear-safe zero-copy**: with n ≥ 2 the producer writes surface *i+1* while a client reads
  the just-published surface *i* — the structural double-buffer that one surface can't provide.

## Proposal B — optional frame synchronization (fixes tearing directly)

If surface rotation is too invasive, a lighter fix is an explicit publish/acquire fence so a client
never samples a partially-written frame — the macOS analog of Spout's keyed mutex. Even an
`IOSurfaceLock`/`IOSurfaceUnlock` seed convention that clients honor, surfaced through the public
client API, would let a careful consumer avoid torn reads.

This is strictly weaker than A (it doesn't remove the copy) but it is the smaller change and would let
the faster `direct` backend become tear-safe — i.e. the default — on its own.

## Compatibility

- Both are **additive**: existing `publishFrameTexture:`/`newSurfaceForWidth:` callers and all current
  clients keep working unchanged. A producer using Proposal A simply skips the copy; an old client
  reading a rotated surface sees a valid frame either way.
- A new option key (e.g. `SyphonServerOptionSurfaceCount`) gates rotation so single-surface clients are
  never surprised.

## If you're a maintainer reading this from the repo

The local side is done and verified — there is no consumer-side optimization left to make (we built
and measured the candidates, including the copy-avoidance attempts, and they bottom out at the framework
boundary above). The fastest next step for the whole Syphon/Electron ecosystem is one of the two
additions above in Syphon-Framework. This note exists to be filed there.
