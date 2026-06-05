//
//  syphon_addon.mm
//  electron-syphon — a Syphon server addon for Electron (macOS / Metal)
//
//  Design goals (driven directly by the known node-syphon pain points):
//
//    * node-syphon #45 — "memory leak: sending pixel data via IPC, Electron
//      serialization copies accumulate". We AVOID this entirely by running the
//      Syphon server in the MAIN process and feeding it the zero-copy IOSurface
//      *handle* delivered by Electron's `paint` event. Only ~8 bytes (a pointer)
//      crosses into native code per frame — never a pixel buffer, never IPC.
//
//    * node-syphon #39 — worker-thread GPU->CPU readback. AVOIDED: the shared
//      texture path never downloads pixels to the CPU.
//
//    * node-syphon #42 — zero-copy via Electron's `useSharedTexture`.
//
//    * Native per-frame leak in node-syphon's PublishImageData (new MTLTexture
//      each frame, no release, ARC off, no autorelease pool). Fixed here with
//      ARC + @autoreleasepool + texture REUSE.
//
//  Performance:
//    * publishSurface       — synchronous (waits for GPU), safe + simple.
//    * publishSurfaceAsync  — submit-only; caller releases the Electron texture
//      a frame later via reap(). Removes the per-frame main-thread GPU stall.
//    * MTLTextures wrapping the rotating IOSurface pool are CACHED, so we don't
//      recreate the wrapper every frame.
//

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#import <Syphon/SyphonMetalServer.h>
#import <Syphon/SyphonMetalClient.h>
#import <Syphon/SyphonServerDirectory.h>
#import <Syphon/SyphonServerBase.h>
#import <Syphon/SyphonSubclassing.h>

// A minimal SyphonServerBase subclass that lets us draw directly into the
// server's published IOSurface (via the SyphonSubclassing category) and advertise
// it with -publish — skipping SyphonMetalServer's internal copy of our texture.
@interface DirectSyphonServer : SyphonServerBase
@end
@implementation DirectSyphonServer
@end

#include <napi.h>
#include <chrono>
#include <vector>

#if !__has_feature(objc_arc)
#error "This file must be compiled with ARC. Set CLANG_ENABLE_OBJC_ARC=YES in binding.gyp."
#endif

namespace {

MTLPixelFormat PixelFormatFromString(const std::string &fmt) {
  if (fmt == "rgba") return MTLPixelFormatRGBA8Unorm;
  return MTLPixelFormatBGRA8Unorm; // default + 'bgra'
}

double NowMs() {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch())
      .count();
}

} // namespace

class SyphonServer : public Napi::ObjectWrap<SyphonServer> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  SyphonServer(const Napi::CallbackInfo &info);
  ~SyphonServer();

private:
  void PublishSurface(const Napi::CallbackInfo &info);
  Napi::Value PublishSurfaceAsync(const Napi::CallbackInfo &info);
  void PublishImageBuffer(const Napi::CallbackInfo &info);
  Napi::Value Reap(const Napi::CallbackInfo &info);
  Napi::Value Drain(const Napi::CallbackInfo &info);
  Napi::Value Benchmark(const Napi::CallbackInfo &info);
  void Dispose(const Napi::CallbackInfo &info);
  Napi::Value GetName(const Napi::CallbackInfo &info);
  Napi::Value GetHasClients(const Napi::CallbackInfo &info);

  bool PublishSurfaceCore(IOSurfaceRef surface, double w, double h, BOOL flipped,
                          BOOL wait);
  void PublishImageCore(const uint8_t *data, NSUInteger w, NSUInteger h,
                        MTLPixelFormat fmt, BOOL flipped, BOOL wait,
                        MTLStorageMode storage = MTLStorageModeManaged);
  id<MTLTexture> TextureForSurface(IOSurfaceRef surface, NSUInteger w,
                                   NSUInteger h);
  void EnsureCpuTexture(NSUInteger w, NSUInteger h, MTLPixelFormat fmt,
                        MTLStorageMode storage);
  uint32_t ReapInternal();
  uint32_t DrainInternal();

  id<MTLDevice> device_ = nil;
  id<MTLCommandQueue> queue_ = nil;
  SyphonMetalServer *server_ = nil;

  // CPU-path texture, reused across frames (anti-leak).
  id<MTLTexture> cpuTexture_ = nil;
  NSUInteger cpuW_ = 0, cpuH_ = 0;
  MTLPixelFormat cpuFmt_ = MTLPixelFormatBGRA8Unorm;
  MTLStorageMode cpuStorage_ = MTLStorageModeManaged;

  // Surface-path: cache one MTLTexture per IOSurface in Electron's rotating
  // pool (keyed by pointer), invalidated when the frame size changes.
  NSMutableDictionary<NSNumber *, id<MTLTexture>> *surfaceTextures_ = nil;
  NSUInteger surfW_ = 0, surfH_ = 0;

  // In-flight command buffers for the async path (submission order == FIFO).
  NSMutableArray<id<MTLCommandBuffer>> *inflight_ = nil;

  // Composite/atlas path: one persistent GPU-private atlas texture that N source
  // surfaces are blitted into (one command buffer), then published ONCE. This is
  // the measured 1.5-6x multi-output win (see benchmarkScaling). Source-surface
  // wrappers are cached by pointer here WITHOUT the single-size assumption of
  // surfaceTextures_, because atlas tiles can differ in size.
  id<MTLTexture> atlas_ = nil;    // active buffer — always holds the latest composite
  id<MTLTexture> atlasAlt_ = nil; // alternate buffer for ping-pong full updates
  NSUInteger atlasW_ = 0, atlasH_ = 0;
  BOOL atlasFilled_ = NO; // has the active atlas been written at least once?
  NSMutableDictionary<NSNumber *, id<MTLTexture>> *atlasSrcTextures_ = nil;

  Napi::Value PublishAtlas(const Napi::CallbackInfo &info);
  id<MTLTexture> AtlasSourceTexture(IOSurfaceRef surface);
};

SyphonServer::SyphonServer(const Napi::CallbackInfo &info)
    : Napi::ObjectWrap<SyphonServer>(info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "new SyphonServer(name: string)")
        .ThrowAsJavaScriptException();
    return;
  }
  std::string name = info[0].As<Napi::String>().Utf8Value();

  @autoreleasepool {
    device_ = MTLCreateSystemDefaultDevice();
    if (!device_) {
      Napi::Error::New(env, "No Metal device available")
          .ThrowAsJavaScriptException();
      return;
    }
    queue_ = [device_ newCommandQueue];
    surfaceTextures_ = [NSMutableDictionary dictionary];
    atlasSrcTextures_ = [NSMutableDictionary dictionary];
    inflight_ = [NSMutableArray array];
    NSString *nsName = [NSString stringWithUTF8String:name.c_str()];
    server_ = [[SyphonMetalServer alloc] initWithName:nsName
                                               device:device_
                                              options:nil];
    if (!server_) {
      Napi::Error::New(env, "Failed to start Syphon server")
          .ThrowAsJavaScriptException();
      return;
    }
  }
}

SyphonServer::~SyphonServer() {
  DrainInternal();
  if (server_) {
    [server_ stop];
    server_ = nil;
  }
  cpuTexture_ = nil;
  surfaceTextures_ = nil;
  atlasSrcTextures_ = nil;
  atlas_ = nil;
  atlasAlt_ = nil;
  inflight_ = nil;
  queue_ = nil;
  device_ = nil;
}

void SyphonServer::Dispose(const Napi::CallbackInfo &info) {
  @autoreleasepool {
    DrainInternal();
    if (server_) {
      [server_ stop];
      server_ = nil;
    }
    cpuTexture_ = nil;
    [surfaceTextures_ removeAllObjects];
    [atlasSrcTextures_ removeAllObjects];
    atlas_ = nil;
    atlasAlt_ = nil;
    atlasW_ = atlasH_ = 0;
    atlasFilled_ = NO;
    cpuW_ = cpuH_ = surfW_ = surfH_ = 0;
  }
}

// --- Surface texture cache + publish cores --------------------------------

id<MTLTexture> SyphonServer::TextureForSurface(IOSurfaceRef surface,
                                               NSUInteger sw, NSUInteger sh) {
  // Frame size changed → the old pool is gone; drop stale wrappers.
  if (sw != surfW_ || sh != surfH_) {
    [surfaceTextures_ removeAllObjects];
    surfW_ = sw;
    surfH_ = sh;
  }
  NSNumber *key = @((uintptr_t)surface);
  id<MTLTexture> t = surfaceTextures_[key];
  if (t) return t;

  MTLTextureDescriptor *desc = [MTLTextureDescriptor
      texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                   width:sw
                                  height:sh
                               mipmapped:NO];
  // Syphon only reads this texture (blit source for flipped:NO, sampled source
  // for the flipped:YES redraw) — it is never a render target, so ShaderRead is
  // the minimal usage. Dropping RenderTarget lets the driver place it optimally.
  desc.usage = MTLTextureUsageShaderRead;
  desc.storageMode = MTLStorageModeShared;
  t = [device_ newTextureWithDescriptor:desc iosurface:surface plane:0];
  if (t) {
    if (surfaceTextures_.count > 32) [surfaceTextures_ removeAllObjects];
    surfaceTextures_[key] = t;
  }
  return t;
}

bool SyphonServer::PublishSurfaceCore(IOSurfaceRef surface, double width,
                                      double height, BOOL flipped, BOOL wait) {
  if (!server_ || !surface) return false;
  @autoreleasepool {
    const NSUInteger sw = IOSurfaceGetWidth(surface);
    const NSUInteger sh = IOSurfaceGetHeight(surface);
    if (sw == 0 || sh == 0) return false;

    id<MTLTexture> tex = TextureForSurface(surface, sw, sh);
    if (!tex) return false;

    NSRect region = NSMakeRect(0, 0, width, height);
    id<MTLCommandBuffer> cmd = [queue_ commandBuffer];
    [server_ publishFrameTexture:tex
                 onCommandBuffer:cmd
                     imageRegion:region
                         flipped:flipped];
    [cmd commit];
    if (wait) {
      [cmd waitUntilCompleted];
    } else {
      [inflight_ addObject:cmd]; // released later by reap()/drain()
    }
  }
  return true;
}

uint32_t SyphonServer::ReapInternal() {
  uint32_t n = 0;
  while (inflight_.count > 0) {
    MTLCommandBufferStatus s = inflight_[0].status;
    if (s == MTLCommandBufferStatusCompleted ||
        s == MTLCommandBufferStatusError) {
      [inflight_ removeObjectAtIndex:0];
      n++;
    } else {
      break; // FIFO: nothing after this is done yet
    }
  }
  return n;
}

uint32_t SyphonServer::DrainInternal() {
  if (!inflight_) return 0;
  uint32_t n = (uint32_t)inflight_.count;
  for (id<MTLCommandBuffer> c in inflight_) [c waitUntilCompleted];
  [inflight_ removeAllObjects];
  return n;
}

// Wrap (and cache) a source IOSurface for the atlas path. Unlike
// TextureForSurface this makes no single-size assumption (tiles may differ), and
// is bounded so it can't grow without limit.
id<MTLTexture> SyphonServer::AtlasSourceTexture(IOSurfaceRef surface) {
  NSNumber *key = @((uintptr_t)surface);
  id<MTLTexture> t = atlasSrcTextures_[key];
  if (t) return t;
  const NSUInteger w = IOSurfaceGetWidth(surface);
  const NSUInteger h = IOSurfaceGetHeight(surface);
  if (w == 0 || h == 0) return nil;
  MTLTextureDescriptor *desc = [MTLTextureDescriptor
      texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                   width:w
                                  height:h
                               mipmapped:NO];
  desc.usage = MTLTextureUsageShaderRead;
  desc.storageMode = MTLStorageModeShared;
  t = [device_ newTextureWithDescriptor:desc iosurface:surface plane:0];
  if (t) {
    // Electron rotates a small pool per source; a few dozen tiles × ~10 surfaces
    // each is the realistic ceiling. Flush if it ever runs away.
    if (atlasSrcTextures_.count > 512) [atlasSrcTextures_ removeAllObjects];
    atlasSrcTextures_[key] = t;
  }
  return t;
}

// publishAtlas(tiles, atlasW, atlasH, flipY) — composite N source IOSurfaces
// into one GPU-private atlas on a single command buffer, then publish ONCE.
// tiles: Array<{ handle: Buffer, x, y, w, h }>. Async (submit-only): the caller
// keeps every source Electron texture alive until a later reap()/drain() reports
// completion (same contract as publishSurfaceAsync — the blit COPIES each source
// into the atlas, so once the buffer completes the sources are free).
// Returns 1 if a frame was enqueued, 0 if nothing valid to publish.
Napi::Value SyphonServer::PublishAtlas(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!server_) return Napi::Number::New(env, 0);
  if (info.Length() < 4 || !info[0].IsArray() || !info[1].IsNumber() ||
      !info[2].IsNumber() || !info[3].IsBoolean()) {
    Napi::TypeError::New(
        env, "publishAtlas(tiles: Array<{handle,x,y,w,h}>, atlasW, atlasH, flipY)")
        .ThrowAsJavaScriptException();
    return Napi::Number::New(env, 0);
  }
  Napi::Array tiles = info[0].As<Napi::Array>();
  const NSUInteger aw = info[1].As<Napi::Number>().Uint32Value();
  const NSUInteger ah = info[2].As<Napi::Number>().Uint32Value();
  const BOOL flipped = info[3].As<Napi::Boolean>().Value() ? YES : NO;
  // fullUpdate (optional): the caller guarantees these tiles cover the ENTIRE
  // atlas, so the published frame is complete on its own. We then write a second
  // buffer and ping-pong — removing the write-after-read hazard where the next
  // frame's blits would otherwise wait for this frame's Syphon copy to finish.
  // Only safe when every cell is rewritten; partial updates must keep the single
  // persistent atlas (its unchanged tiles are the previous contents).
  const BOOL fullUpdate = (info.Length() > 4 && info[4].IsBoolean())
                              ? info[4].As<Napi::Boolean>().Value()
                              : NO;
  const uint32_t count = tiles.Length();
  // count == 0 is allowed: it republishes the persisted atlas as-is (used to
  // feed a newly-connected client on a static wall).
  if (aw == 0 || ah == 0) return Napi::Number::New(env, 0);

  @autoreleasepool {
    // (Re)allocate the persistent private atlas if the size changed.
    if (!atlas_ || atlasW_ != aw || atlasH_ != ah) {
      MTLTextureDescriptor *ad = [MTLTextureDescriptor
          texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                       width:aw
                                      height:ah
                                   mipmapped:NO];
      ad.usage = MTLTextureUsageShaderRead;
      ad.storageMode = MTLStorageModePrivate;
      atlas_ = [device_ newTextureWithDescriptor:ad];
      atlasAlt_ = nil; // alternate buffer is stale at the new size; realloc lazily
      atlasW_ = aw;
      atlasH_ = ah;
      atlasFilled_ = NO; // fresh atlas has undefined contents until first blit
    }
    if (!atlas_) return Napi::Number::New(env, 0);

    // Pick this frame's blit destination. Full updates target the alternate
    // buffer (lazily allocated) so they never collide with the in-flight read of
    // the active buffer; partial updates write the active buffer in place.
    id<MTLTexture> dst = atlas_;
    if (fullUpdate) {
      if (!atlasAlt_) {
        MTLTextureDescriptor *ad = [MTLTextureDescriptor
            texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                         width:aw
                                        height:ah
                                     mipmapped:NO];
        ad.usage = MTLTextureUsageShaderRead;
        ad.storageMode = MTLStorageModePrivate;
        atlasAlt_ = [device_ newTextureWithDescriptor:ad];
      }
      if (atlasAlt_) dst = atlasAlt_;
    }

    id<MTLCommandBuffer> cmd = [queue_ commandBuffer];
    id<MTLBlitCommandEncoder> blit = [cmd blitCommandEncoder];
    uint32_t blitted = 0;
    for (uint32_t i = 0; i < count; i++) {
      Napi::Value tv = tiles[i];
      if (!tv.IsObject()) continue;
      Napi::Object tile = tv.As<Napi::Object>();
      Napi::Value hv = tile.Get("handle");
      if (!hv.IsBuffer()) continue;
      Napi::Buffer<uint8_t> handle = hv.As<Napi::Buffer<uint8_t>>();
      if (handle.Length() < sizeof(void *)) continue;
      IOSurfaceRef surface = *reinterpret_cast<IOSurfaceRef *>(handle.Data());
      if (!surface) continue;
      id<MTLTexture> src = AtlasSourceTexture(surface);
      if (!src) continue;

      const NSUInteger sw = src.width, sh = src.height;
      NSUInteger dx = tile.Has("x") ? tile.Get("x").ToNumber().Uint32Value() : 0;
      NSUInteger dy = tile.Has("y") ? tile.Get("y").ToNumber().Uint32Value() : 0;
      // Clip the copy to the atlas bounds so a stray rect can't fault the blit.
      NSUInteger cw = tile.Has("w") ? tile.Get("w").ToNumber().Uint32Value() : sw;
      NSUInteger ch = tile.Has("h") ? tile.Get("h").ToNumber().Uint32Value() : sh;
      cw = MIN(cw, sw);
      ch = MIN(ch, sh);
      if (dx >= aw || dy >= ah) continue;
      cw = MIN(cw, aw - dx);
      ch = MIN(ch, ah - dy);
      if (cw == 0 || ch == 0) continue;

      // Syphon flips the WHOLE atlas when flipped:YES, which would mirror the
      // grid layout (top row -> bottom). Pre-mirror each tile's row placement so
      // it lands back in its own cell after the flip — giving a grid-preserving
      // per-tile flip that matches the direct backend (instead of a flipped
      // grid). No-op when not flipped.
      const NSUInteger ddy = flipped ? (ah - dy - ch) : dy;

      [blit copyFromTexture:src
                sourceSlice:0
                sourceLevel:0
               sourceOrigin:MTLOriginMake(0, 0, 0)
                 sourceSize:MTLSizeMake(cw, ch, 1)
                  toTexture:dst
           destinationSlice:0
           destinationLevel:0
          destinationOrigin:MTLOriginMake(dx, ddy, 0)];
      blitted++;
    }
    [blit endEncoding];

    // Can we publish? A full update into the alternate buffer is a complete
    // frame whenever it blitted anything; a write into the active buffer is
    // valid once that buffer has ever been filled (partial/0-dirty republish).
    const bool usingAlt = (dst == atlasAlt_);
    if (!usingAlt && blitted > 0) atlasFilled_ = YES;
    const bool canPublish = usingAlt ? (blitted > 0) : atlasFilled_;
    if (!canPublish) {
      [cmd commit];
      return Napi::Number::New(env, 0);
    }
    NSRect region = NSMakeRect(0, 0, aw, ah);
    [server_ publishFrameTexture:dst
                 onCommandBuffer:cmd
                     imageRegion:region
                         flipped:flipped];
    [cmd commit];
    [inflight_ addObject:cmd]; // released later by reap()/drain()

    if (usingAlt) {
      // The freshly published full frame becomes the active/latest; the old
      // active becomes the alternate for the next full update (ping-pong).
      atlasAlt_ = atlas_;
      atlas_ = dst;
      atlasFilled_ = YES;
    }
  }
  return Napi::Number::New(env, 1);
}

void SyphonServer::EnsureCpuTexture(NSUInteger w, NSUInteger h,
                                    MTLPixelFormat fmt, MTLStorageMode storage) {
  if (cpuTexture_ && cpuW_ == w && cpuH_ == h && cpuFmt_ == fmt &&
      cpuStorage_ == storage)
    return;
  MTLTextureDescriptor *desc =
      [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:fmt
                                                         width:w
                                                        height:h
                                                     mipmapped:NO];
  desc.usage = MTLTextureUsageShaderRead;
  desc.storageMode = storage;
  cpuTexture_ = [device_ newTextureWithDescriptor:desc];
  cpuW_ = w;
  cpuH_ = h;
  cpuFmt_ = fmt;
  cpuStorage_ = storage;
}

void SyphonServer::PublishImageCore(const uint8_t *data, NSUInteger w,
                                    NSUInteger h, MTLPixelFormat fmt,
                                    BOOL flipped, BOOL wait,
                                    MTLStorageMode storage) {
  if (!server_ || w == 0 || h == 0) return;
  @autoreleasepool {
    EnsureCpuTexture(w, h, fmt, storage);
    [cpuTexture_ replaceRegion:MTLRegionMake2D(0, 0, w, h)
                   mipmapLevel:0
                     withBytes:data
                   bytesPerRow:w * 4];
    NSRect region = NSMakeRect(0, 0, w, h);
    id<MTLCommandBuffer> cmd = [queue_ commandBuffer];
    [server_ publishFrameTexture:cpuTexture_
                 onCommandBuffer:cmd
                     imageRegion:region
                         flipped:flipped];
    [cmd commit];
    if (wait) [cmd waitUntilCompleted];
  }
}

// --- N-API entry points ---------------------------------------------------

static bool DecodeSurface(const Napi::CallbackInfo &info, IOSurfaceRef *out) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[0].IsBuffer() || !info[1].IsNumber() ||
      !info[2].IsNumber() || !info[3].IsBoolean()) {
    Napi::TypeError::New(env, "(handle: Buffer, width, height, flipY: boolean)")
        .ThrowAsJavaScriptException();
    return false;
  }
  Napi::Buffer<uint8_t> handle = info[0].As<Napi::Buffer<uint8_t>>();
  if (handle.Length() < sizeof(void *)) {
    Napi::Error::New(env, "shared texture handle is too small")
        .ThrowAsJavaScriptException();
    return false;
  }
  *out = *reinterpret_cast<IOSurfaceRef *>(handle.Data());
  return true;
}

// Synchronous zero-copy publish (waits for GPU; caller can release immediately).
void SyphonServer::PublishSurface(const Napi::CallbackInfo &info) {
  if (!server_) return;
  IOSurfaceRef surface = nullptr;
  if (!DecodeSurface(info, &surface) || !surface) return;
  PublishSurfaceCore(surface, info[1].As<Napi::Number>().DoubleValue(),
                     info[2].As<Napi::Number>().DoubleValue(),
                     info[3].As<Napi::Boolean>().Value() ? YES : NO, YES);
}

// Async zero-copy publish: submit only, do NOT wait. Returns 1 if a frame was
// enqueued (caller must keep the Electron texture alive and release it once a
// later reap() reports completion), 0 if skipped.
Napi::Value SyphonServer::PublishSurfaceAsync(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!server_) return Napi::Number::New(env, 0);
  IOSurfaceRef surface = nullptr;
  if (!DecodeSurface(info, &surface) || !surface) return Napi::Number::New(env, 0);
  bool ok = PublishSurfaceCore(surface, info[1].As<Napi::Number>().DoubleValue(),
                               info[2].As<Napi::Number>().DoubleValue(),
                               info[3].As<Napi::Boolean>().Value() ? YES : NO,
                               NO);
  return Napi::Number::New(env, ok ? 1 : 0);
}

// Returns how many async frames have finished on the GPU since the last call
// (and drops them). The caller releases that many Electron textures, in order.
Napi::Value SyphonServer::Reap(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), ReapInternal());
}

// Waits for all in-flight async frames; returns how many were drained.
Napi::Value SyphonServer::Drain(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), DrainInternal());
}

// CPU fallback path: (pixels, width, height, 'rgba'|'bgra', flipY)
void SyphonServer::PublishImageBuffer(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!server_) return;
  if (info.Length() < 5 || !info[0].IsBuffer() || !info[1].IsNumber() ||
      !info[2].IsNumber() || !info[3].IsString() || !info[4].IsBoolean()) {
    Napi::TypeError::New(env, "publishImageBuffer(pixels, width, height, "
                              "format: 'rgba'|'bgra', flipY: boolean)")
        .ThrowAsJavaScriptException();
    return;
  }
  Napi::Buffer<uint8_t> pixels = info[0].As<Napi::Buffer<uint8_t>>();
  NSUInteger width = info[1].As<Napi::Number>().Uint32Value();
  NSUInteger height = info[2].As<Napi::Number>().Uint32Value();
  MTLPixelFormat fmt =
      PixelFormatFromString(info[3].As<Napi::String>().Utf8Value());
  BOOL flipped = info[4].As<Napi::Boolean>().Value() ? YES : NO;
  if (width == 0 || height == 0) return;
  if (pixels.Length() < (size_t)width * height * 4) {
    Napi::Error::New(env, "pixel buffer smaller than width*height*4")
        .ThrowAsJavaScriptException();
    return;
  }
  PublishImageCore(pixels.Data(), width, height, fmt, flipped, YES);
}

// Benchmark the publish path at a resolution, isolated from Electron.
// Args: ({ width, height, iterations, mode:'surface'|'image', wait })
Napi::Value SyphonServer::Benchmark(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!server_) {
    Napi::Error::New(env, "server disposed").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Object opts = (info.Length() > 0 && info[0].IsObject())
                          ? info[0].As<Napi::Object>()
                          : Napi::Object::New(env);
  auto numOr = [&](const char *k, uint32_t d) -> uint32_t {
    return opts.Has(k) ? opts.Get(k).ToNumber().Uint32Value() : d;
  };
  NSUInteger width = numOr("width", 1920);
  NSUInteger height = numOr("height", 1080);
  uint32_t iterations = numOr("iterations", 600);
  bool wait = opts.Has("wait") ? opts.Get("wait").ToBoolean().Value() : true;
  std::string mode =
      opts.Has("mode") ? opts.Get("mode").ToString().Utf8Value() : "surface";
  // Variants under test:
  BOOL flipped = opts.Has("flip") ? (opts.Get("flip").ToBoolean().Value() ? YES : NO) : YES;
  std::string storageStr =
      opts.Has("storage") ? opts.Get("storage").ToString().Utf8Value() : "managed";
  MTLStorageMode storage =
      storageStr == "shared" ? MTLStorageModeShared : MTLStorageModeManaged;
  double total = 0.0;

  @autoreleasepool {
    if (mode == "image") {
      std::vector<uint8_t> buf((size_t)width * height * 4, 0x80);
      PublishImageCore(buf.data(), width, height, MTLPixelFormatBGRA8Unorm,
                       flipped, YES, storage); // warm up
      double t0 = NowMs();
      for (uint32_t i = 0; i < iterations; i++)
        PublishImageCore(buf.data(), width, height, MTLPixelFormatBGRA8Unorm,
                         flipped, wait ? YES : NO, storage);
      total = NowMs() - t0;
    } else {
      NSDictionary *props = @{
        (id)kIOSurfaceWidth : @(width),
        (id)kIOSurfaceHeight : @(height),
        (id)kIOSurfaceBytesPerElement : @(4),
        (id)kIOSurfacePixelFormat : @((uint32_t)'BGRA'),
      };
      IOSurfaceRef surface = IOSurfaceCreate((__bridge CFDictionaryRef)props);
      if (!surface) {
        Napi::Error::New(env, "IOSurfaceCreate failed")
            .ThrowAsJavaScriptException();
        return env.Null();
      }
      IOSurfaceLock(surface, 0, nullptr);
      memset(IOSurfaceGetBaseAddress(surface), 0x80,
             IOSurfaceGetAllocSize(surface));
      IOSurfaceUnlock(surface, 0, nullptr);

      PublishSurfaceCore(surface, width, height, flipped, YES); // warm up
      double t0 = NowMs();
      for (uint32_t i = 0; i < iterations; i++) {
        PublishSurfaceCore(surface, width, height, flipped, wait ? YES : NO);
        if (!wait) ReapInternal(); // keep in-flight queue shallow
      }
      DrainInternal();
      total = NowMs() - t0;
      [surfaceTextures_ removeAllObjects];
      surfW_ = surfH_ = 0;
      CFRelease(surface);
    }
  }

  double avg = total / iterations;
  double fps = avg > 0 ? 1000.0 / avg : 0.0;
  Napi::Object out = Napi::Object::New(env);
  out.Set("mode", Napi::String::New(env, mode));
  out.Set("width", Napi::Number::New(env, width));
  out.Set("height", Napi::Number::New(env, height));
  out.Set("iterations", Napi::Number::New(env, iterations));
  out.Set("wait", Napi::Boolean::New(env, wait));
  out.Set("flip", Napi::Boolean::New(env, flipped == YES));
  out.Set("storage", Napi::String::New(env, storageStr));
  out.Set("totalMs", Napi::Number::New(env, total));
  out.Set("avgMs", Napi::Number::New(env, avg));
  out.Set("fps", Napi::Number::New(env, fps));
  out.Set("megapixels", Napi::Number::New(env, (double)width * height / 1e6));
  out.Set("throughputGBps",
          Napi::Number::New(env, (double)width * height * 4.0 * iterations /
                                     (total / 1000.0) / 1e9));
  return out;
}

Napi::Value SyphonServer::GetName(const Napi::CallbackInfo &info) {
  if (!server_) return info.Env().Null();
  return Napi::String::New(info.Env(),
                           server_.name ? server_.name.UTF8String : "");
}

Napi::Value SyphonServer::GetHasClients(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(info.Env(), server_ ? server_.hasClients : false);
}

Napi::Object SyphonServer::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(
      env, "SyphonServer",
      {
          InstanceMethod("publishSurface", &SyphonServer::PublishSurface),
          InstanceMethod("publishSurfaceAsync", &SyphonServer::PublishSurfaceAsync),
          InstanceMethod("publishAtlas", &SyphonServer::PublishAtlas),
          InstanceMethod("publishImageBuffer", &SyphonServer::PublishImageBuffer),
          InstanceMethod("reap", &SyphonServer::Reap),
          InstanceMethod("drain", &SyphonServer::Drain),
          InstanceMethod("benchmark", &SyphonServer::Benchmark),
          InstanceMethod("dispose", &SyphonServer::Dispose),
          InstanceAccessor("name", &SyphonServer::GetName, nullptr),
          InstanceAccessor("hasClients", &SyphonServer::GetHasClients, nullptr),
      });
  exports.Set("SyphonServer", func);
  return exports;
}

// ---------------------------------------------------------------------------
//  SyphonClient — the receiver. Connects to a server by name and pulls frames,
//  so tests/benchmarks can verify frames are actually received (and sample a
//  pixel to confirm they aren't black).
// ---------------------------------------------------------------------------
class SyphonClient : public Napi::ObjectWrap<SyphonClient> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  SyphonClient(const Napi::CallbackInfo &info);
  ~SyphonClient();

private:
  Napi::Value Receive(const Napi::CallbackInfo &info);
  Napi::Value ReceiveFrame(const Napi::CallbackInfo &info);
  Napi::Value GetIsValid(const Napi::CallbackInfo &info);
  Napi::Value GetHasNewFrame(const Napi::CallbackInfo &info);
  void Dispose(const Napi::CallbackInfo &info);

  id<MTLDevice> device_ = nil;
  id<MTLCommandQueue> queue_ = nil;
  SyphonMetalClient *client_ = nil;
  // Reused full-frame readback target for receiveFrame() (anti-leak).
  id<MTLTexture> readTex_ = nil;
  NSUInteger readW_ = 0, readH_ = 0;
};

SyphonClient::SyphonClient(const Napi::CallbackInfo &info)
    : Napi::ObjectWrap<SyphonClient>(info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "new SyphonClient(serverName: string)")
        .ThrowAsJavaScriptException();
    return;
  }
  std::string name = info[0].As<Napi::String>().Utf8Value();
  @autoreleasepool {
    device_ = MTLCreateSystemDefaultDevice();
    queue_ = [device_ newCommandQueue];
    NSString *nsName = [NSString stringWithUTF8String:name.c_str()];
    NSArray *matches =
        [[SyphonServerDirectory sharedDirectory] serversMatchingName:nsName
                                                             appName:nil];
    if (matches.count == 0) return; // server not announced (yet) → invalid
    client_ = [[SyphonMetalClient alloc] initWithServerDescription:matches[0]
                                                            device:device_
                                                           options:nil
                                                   newFrameHandler:nil];
  }
}

SyphonClient::~SyphonClient() {
  if (client_) {
    [client_ stop];
    client_ = nil;
  }
  readTex_ = nil;
  queue_ = nil;
  device_ = nil;
}

void SyphonClient::Dispose(const Napi::CallbackInfo &info) {
  if (client_) {
    [client_ stop];
    client_ = nil;
  }
  readTex_ = nil;
}

// Receive(sample?: boolean) →
//   { valid, hasFrame, width, height, [nonBlack, r, g, b, a] }
// With sample=true it blits the centre pixel into a CPU-readable texture so we
// can confirm the received frame actually has content (not a black surface).
Napi::Value SyphonClient::Receive(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  bool sample = info.Length() > 0 && info[0].ToBoolean().Value();
  out.Set("valid", Napi::Boolean::New(env, client_ ? client_.isValid : false));
  if (!client_) {
    out.Set("hasFrame", Napi::Boolean::New(env, false));
    return out;
  }
  @autoreleasepool {
    id<MTLTexture> tex = [client_ newFrameImage];
    if (!tex) {
      out.Set("hasFrame", Napi::Boolean::New(env, false));
      return out;
    }
    const NSUInteger w = tex.width, h = tex.height;
    out.Set("hasFrame", Napi::Boolean::New(env, true));
    out.Set("width", Napi::Number::New(env, w));
    out.Set("height", Napi::Number::New(env, h));
    if (sample && w > 0 && h > 0) {
      // Sample a 16×16 region, off-centre, then flag nonBlack if ANY pixel has
      // content. (Dead-centre can land on e.g. a composite grid's black gutter.)
      const NSUInteger N = (w >= 32 && h >= 32) ? 16 : 1;
      const NSUInteger ox = w / 3;
      const NSUInteger oy = h / 3;
      MTLTextureDescriptor *d = [MTLTextureDescriptor
          texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                       width:N
                                      height:N
                                   mipmapped:NO];
      d.storageMode = MTLStorageModeShared;
      id<MTLTexture> dst = [device_ newTextureWithDescriptor:d];
      id<MTLCommandBuffer> cb = [queue_ commandBuffer];
      id<MTLBlitCommandEncoder> blit = [cb blitCommandEncoder];
      [blit copyFromTexture:tex
                sourceSlice:0
                sourceLevel:0
               sourceOrigin:MTLOriginMake(ox, oy, 0)
                 sourceSize:MTLSizeMake(N, N, 1)
                  toTexture:dst
           destinationSlice:0
           destinationLevel:0
          destinationOrigin:MTLOriginMake(0, 0, 0)];
      [blit endEncoding];
      [cb commit];
      [cb waitUntilCompleted];
      std::vector<uint8_t> px(N * N * 4, 0);
      [dst getBytes:px.data()
          bytesPerRow:N * 4
           fromRegion:MTLRegionMake2D(0, 0, N, N)
          mipmapLevel:0];
      bool nonBlack = false;
      for (size_t i = 0; i < px.size(); i += 4) {
        if (px[i] > 8 || px[i + 1] > 8 || px[i + 2] > 8) { nonBlack = true; break; }
      }
      out.Set("b", Napi::Number::New(env, px[0]));
      out.Set("g", Napi::Number::New(env, px[1]));
      out.Set("r", Napi::Number::New(env, px[2]));
      out.Set("a", Napi::Number::New(env, px[3]));
      out.Set("nonBlack", Napi::Boolean::New(env, nonBlack));
    }
    return out;
  }
}

// ReceiveFrame() → { valid, hasFrame, width, height, pixels?: Buffer(RGBA) }
// Full-frame GPU→CPU readback so a monitor window can DISPLAY exactly what is
// being published — the visible window then shows the *sent* frames, not a
// second parallel render. This is a deliberate readback (not the publish path);
// it reuses one Shared texture across calls so it never leaks.
Napi::Value SyphonClient::ReceiveFrame(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  out.Set("valid", Napi::Boolean::New(env, client_ ? client_.isValid : false));
  if (!client_) {
    out.Set("hasFrame", Napi::Boolean::New(env, false));
    return out;
  }
  @autoreleasepool {
    id<MTLTexture> tex = [client_ newFrameImage];
    if (!tex) {
      out.Set("hasFrame", Napi::Boolean::New(env, false));
      return out;
    }
    const NSUInteger w = tex.width, h = tex.height;
    out.Set("hasFrame", Napi::Boolean::New(env, true));
    out.Set("width", Napi::Number::New(env, w));
    out.Set("height", Napi::Number::New(env, h));
    if (w == 0 || h == 0) return out;

    // Reuse one Shared BGRA texture sized to the frame (anti-leak).
    if (!readTex_ || readW_ != w || readH_ != h) {
      MTLTextureDescriptor *d = [MTLTextureDescriptor
          texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                       width:w
                                      height:h
                                   mipmapped:NO];
      d.storageMode = MTLStorageModeShared;
      readTex_ = [device_ newTextureWithDescriptor:d];
      readW_ = w;
      readH_ = h;
    }
    if (!readTex_) return out;

    id<MTLCommandBuffer> cb = [queue_ commandBuffer];
    id<MTLBlitCommandEncoder> blit = [cb blitCommandEncoder];
    [blit copyFromTexture:tex
              sourceSlice:0
              sourceLevel:0
             sourceOrigin:MTLOriginMake(0, 0, 0)
               sourceSize:MTLSizeMake(w, h, 1)
                toTexture:readTex_
         destinationSlice:0
         destinationLevel:0
        destinationOrigin:MTLOriginMake(0, 0, 0)];
    [blit endEncoding];
    [cb commit];
    [cb waitUntilCompleted];

    const size_t n = (size_t)w * h * 4;
    Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::New(env, n);
    uint8_t *dst = buf.Data();
    [readTex_ getBytes:dst
           bytesPerRow:w * 4
            fromRegion:MTLRegionMake2D(0, 0, w, h)
           mipmapLevel:0];
    // BGRA (Metal) → RGBA (canvas ImageData); force opaque alpha.
    for (size_t i = 0; i < n; i += 4) {
      uint8_t b = dst[i];
      dst[i] = dst[i + 2];
      dst[i + 2] = b;
      dst[i + 3] = 255;
    }
    out.Set("pixels", buf);
    return out;
  }
}

Napi::Value SyphonClient::GetIsValid(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(info.Env(), client_ ? client_.isValid : false);
}

Napi::Value SyphonClient::GetHasNewFrame(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(info.Env(), client_ ? client_.hasNewFrame : false);
}

Napi::Object SyphonClient::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(
      env, "SyphonClient",
      {
          InstanceMethod("receive", &SyphonClient::Receive),
          InstanceMethod("receiveFrame", &SyphonClient::ReceiveFrame),
          InstanceMethod("dispose", &SyphonClient::Dispose),
          InstanceAccessor("isValid", &SyphonClient::GetIsValid, nullptr),
          InstanceAccessor("hasNewFrame", &SyphonClient::GetHasNewFrame, nullptr),
      });
  exports.Set("SyphonClient", func);
  return exports;
}

static id<MTLTexture> WrapSurface(id<MTLDevice> dev, IOSurfaceRef s,
                                  NSUInteger w, NSUInteger h); // defined below

// ---------------------------------------------------------------------------
//  DirectServer — EXPERIMENTAL zero-copy composite. Blits source tiles straight
//  into the Syphon server's own published IOSurface (SyphonSubclassing) and
//  calls -publish, skipping SyphonMetalServer's internal copy. Measured ~1.3-1.4x
//  over the atlas path. Gated on correctness (tearing/orientation) before it can
//  back a production CompositeSyphonOutput path. No flip: a blit can't mirror, so
//  this is flipY=false semantics (sources must be pre-oriented).
// ---------------------------------------------------------------------------
class DirectServer : public Napi::ObjectWrap<DirectServer> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  DirectServer(const Napi::CallbackInfo &info);
  ~DirectServer();

private:
  Napi::Value PublishAtlas(const Napi::CallbackInfo &info);
  Napi::Value Reap(const Napi::CallbackInfo &info);
  Napi::Value Drain(const Napi::CallbackInfo &info);
  Napi::Value GetHasClients(const Napi::CallbackInfo &info);
  Napi::Value GetName(const Napi::CallbackInfo &info);
  void Dispose(const Napi::CallbackInfo &info);
  id<MTLTexture> SourceTexture(IOSurfaceRef s);
  uint32_t ReapInternal();
  bool EnsurePipeline();

  id<MTLDevice> device_ = nil;
  id<MTLCommandQueue> queue_ = nil;
  id<MTLRenderPipelineState> pso_ = nil; // composite-with-optional-flip shader
  DirectSyphonServer *server_ = nil;
  IOSurfaceRef pub_ = nullptr;     // the server's published surface
  id<MTLTexture> pubTex_ = nil;    // pub_ wrapped as a render target
  NSUInteger pubW_ = 0, pubH_ = 0; // published surface size (= native * scale_)
  double scale_ = 1.0;             // publish at this fraction of native size
  NSMutableDictionary<NSNumber *, id<MTLTexture>> *srcTex_ = nil;
  NSMutableArray<id<MTLCommandBuffer>> *inflight_ = nil;
};

DirectServer::DirectServer(const Napi::CallbackInfo &info)
    : Napi::ObjectWrap<DirectServer>(info) {
  Napi::Env env = info.Env();
  std::string name = info[0].As<Napi::String>().Utf8Value();
  if (info.Length() > 1 && info[1].IsNumber()) {
    double s = info[1].As<Napi::Number>().DoubleValue();
    if (s > 0 && s <= 1) scale_ = s;
  }
  @autoreleasepool {
    device_ = MTLCreateSystemDefaultDevice();
    queue_ = [device_ newCommandQueue];
    srcTex_ = [NSMutableDictionary dictionary];
    inflight_ = [NSMutableArray array];
    server_ = [[DirectSyphonServer alloc]
        initWithName:[NSString stringWithUTF8String:name.c_str()]
             options:nil];
    if (!server_)
      Napi::Error::New(env, "DirectSyphonServer init failed")
          .ThrowAsJavaScriptException();
  }
}

DirectServer::~DirectServer() {
  if (server_) [server_ stop];
  if (pub_) CFRelease(pub_);
  pub_ = nullptr;
  pubTex_ = nil;
  pso_ = nil;
  srcTex_ = nil;
  inflight_ = nil;
  server_ = nil;
  queue_ = nil;
  device_ = nil;
}

void DirectServer::Dispose(const Napi::CallbackInfo &info) {
  @autoreleasepool {
    for (id<MTLCommandBuffer> c in inflight_) [c waitUntilCompleted];
    [inflight_ removeAllObjects];
    if (server_) { [server_ stop]; server_ = nil; }
    if (pub_) { CFRelease(pub_); pub_ = nullptr; }
    pubTex_ = nil;
    [srcTex_ removeAllObjects];
    pubW_ = pubH_ = 0;
  }
}

id<MTLTexture> DirectServer::SourceTexture(IOSurfaceRef s) {
  NSNumber *key = @((uintptr_t)s);
  id<MTLTexture> t = srcTex_[key];
  if (t) return t;
  const NSUInteger w = IOSurfaceGetWidth(s), h = IOSurfaceGetHeight(s);
  if (w == 0 || h == 0) return nil;
  t = WrapSurface(device_, s, w, h);
  if (t) {
    if (srcTex_.count > 512) [srcTex_ removeAllObjects];
    srcTex_[key] = t;
  }
  return t;
}

// Compile the composite shader once: a per-tile textured quad, with optional
// vertical flip selected by a vertex uniform (so the zero-copy path serves both
// flipY=false and flipY=true). Measured FASTER than the blit path too — one
// render encoder with cheap viewport switches beats N separate blit calls.
bool DirectServer::EnsurePipeline() {
  if (pso_) return true;
  NSError *err = nil;
  NSString *msl =
      @"#include <metal_stdlib>\n using namespace metal;\n"
      @"struct VOut { float4 pos [[position]]; float2 uv; };\n"
      @"vertex VOut vmain(uint vid [[vertex_id]], constant uint& flip [[buffer(0)]]) {\n"
      @"  float2 p[4] = { float2(-1,-1), float2(1,-1), float2(-1,1), float2(1,1) };\n"
      // Metal framebuffer y is top-down and NDC +y maps to the viewport top, so
      // 'pass' (source unchanged, flipY=false) pairs viewport-top with v=0, and
      // 'flip' (flipY=true) pairs viewport-top with v=1.
      @"  float2 pass[4] = { float2(0,1), float2(1,1), float2(0,0), float2(1,0) };\n"
      @"  float2 flp[4]  = { float2(0,0), float2(1,0), float2(0,1), float2(1,1) };\n"
      @"  VOut o; o.pos = float4(p[vid],0,1); o.uv = flip ? flp[vid] : pass[vid]; return o; }\n"
      @"fragment float4 fmain(VOut in [[stage_in]], texture2d<float> t [[texture(0)]]) {\n"
      @"  constexpr sampler s(filter::linear); return t.sample(s, in.uv); }\n"; // linear: clean downscale
  id<MTLLibrary> lib = [device_ newLibraryWithSource:msl options:nil error:&err];
  if (!lib) return false;
  MTLRenderPipelineDescriptor *pd = [[MTLRenderPipelineDescriptor alloc] init];
  pd.vertexFunction = [lib newFunctionWithName:@"vmain"];
  pd.fragmentFunction = [lib newFunctionWithName:@"fmain"];
  pd.colorAttachments[0].pixelFormat = MTLPixelFormatBGRA8Unorm;
  pso_ = [device_ newRenderPipelineStateWithDescriptor:pd error:&err];
  return pso_ != nil;
}

// publishAtlas(tiles, w, h, flipY, fullUpdate) — atlas-compatible signature so it
// can stand in for SyphonServer in CompositeSyphonOutput. Composites the tiles
// (each flipped in place when flipY) in ONE render pass straight into the
// server's published surface, then -publish after GPU completion. loadAction=Load
// preserves unchanged tiles, so partial updates work. fullUpdate is ignored (one
// persistent surface, no ping-pong). Async: the caller keeps each source texture
// alive until reap()/drain() reports the pass done.
Napi::Value DirectServer::PublishAtlas(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!server_) return Napi::Number::New(env, 0);
  Napi::Array tiles = info[0].As<Napi::Array>();
  const NSUInteger w = info[1].As<Napi::Number>().Uint32Value();
  const NSUInteger h = info[2].As<Napi::Number>().Uint32Value();
  const BOOL flip = (info.Length() > 3 && info[3].IsBoolean())
                        ? info[3].As<Napi::Boolean>().Value() : NO;
  if (w == 0 || h == 0) return Napi::Number::New(env, 0);
  if (!EnsurePipeline()) return Napi::Number::New(env, 0);

  // Published surface is the native composite size scaled by scale_ (downscaling
  // the whole wall during the composite render — free since it's already a
  // sampling pass — for consumers that display it smaller than native).
  const NSUInteger ow = MAX((NSUInteger)1, (NSUInteger)llround(w * scale_));
  const NSUInteger oh = MAX((NSUInteger)1, (NSUInteger)llround(h * scale_));

  @autoreleasepool {
    if (!pub_ || pubW_ != ow || pubH_ != oh) {
      if (pub_) CFRelease(pub_);
      pub_ = [server_ newSurfaceForWidth:ow height:oh options:nil]; // returns +1
      if (!pub_) return Napi::Number::New(env, 0);
      MTLTextureDescriptor *rd = [MTLTextureDescriptor
          texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                       width:ow height:oh mipmapped:NO];
      rd.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
      rd.storageMode = MTLStorageModeShared;
      pubTex_ = [device_ newTextureWithDescriptor:rd iosurface:pub_ plane:0];
      pubW_ = ow; pubH_ = oh;
    }
    if (!pubTex_) return Napi::Number::New(env, 0);

    id<MTLCommandBuffer> cmd = [queue_ commandBuffer];
    MTLRenderPassDescriptor *rp = [MTLRenderPassDescriptor renderPassDescriptor];
    rp.colorAttachments[0].texture = pubTex_;
    rp.colorAttachments[0].loadAction = MTLLoadActionLoad; // keep unchanged tiles
    rp.colorAttachments[0].storeAction = MTLStoreActionStore;
    id<MTLRenderCommandEncoder> enc =
        [cmd renderCommandEncoderWithDescriptor:rp];
    [enc setRenderPipelineState:pso_];
    uint32_t flipU = flip ? 1u : 0u;
    [enc setVertexBytes:&flipU length:sizeof(flipU) atIndex:0];

    uint32_t count = tiles.Length(), drawn = 0;
    for (uint32_t i = 0; i < count; i++) {
      Napi::Value tv = tiles[i];
      if (!tv.IsObject()) continue;
      Napi::Object tile = tv.As<Napi::Object>();
      Napi::Value hv = tile.Get("handle");
      if (!hv.IsBuffer()) continue;
      Napi::Buffer<uint8_t> handle = hv.As<Napi::Buffer<uint8_t>>();
      if (handle.Length() < sizeof(void *)) continue;
      IOSurfaceRef s = *reinterpret_cast<IOSurfaceRef *>(handle.Data());
      if (!s) continue;
      id<MTLTexture> src = SourceTexture(s);
      if (!src) continue;
      NSUInteger dx = tile.Has("x") ? tile.Get("x").ToNumber().Uint32Value() : 0;
      NSUInteger dy = tile.Has("y") ? tile.Get("y").ToNumber().Uint32Value() : 0;
      NSUInteger cw = tile.Has("w") ? tile.Get("w").ToNumber().Uint32Value() : src.width;
      NSUInteger ch = tile.Has("h") ? tile.Get("h").ToNumber().Uint32Value() : src.height;
      if (dx >= w || dy >= h) continue;
      cw = MIN(cw, w - dx);
      ch = MIN(ch, h - dy);
      if (cw == 0 || ch == 0) continue;
      // Tile rect scaled into the (possibly downscaled) published surface.
      [enc setViewport:(MTLViewport){dx * scale_, dy * scale_, cw * scale_,
                                     ch * scale_, 0.0, 1.0}];
      [enc setFragmentTexture:src atIndex:0];
      [enc drawPrimitives:MTLPrimitiveTypeTriangleStrip vertexStart:0 vertexCount:4];
      drawn++;
    }
    [enc endEncoding];
    if (drawn == 0) { [cmd commit]; return Napi::Number::New(env, 0); }
    __weak DirectSyphonServer *wsrv = server_;
    [cmd addCompletedHandler:^(id<MTLCommandBuffer> _Nonnull) { [wsrv publish]; }];
    [cmd commit];
    [inflight_ addObject:cmd]; // released by reap()/drain() once the pass is done
  }
  return Napi::Number::New(env, 1);
}

uint32_t DirectServer::ReapInternal() {
  uint32_t n = 0;
  while (inflight_.count > 0) {
    MTLCommandBufferStatus s = inflight_[0].status;
    if (s == MTLCommandBufferStatusCompleted || s == MTLCommandBufferStatusError) {
      [inflight_ removeObjectAtIndex:0];
      n++;
    } else {
      break;
    }
  }
  return n;
}

Napi::Value DirectServer::Reap(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), ReapInternal());
}

Napi::Value DirectServer::Drain(const Napi::CallbackInfo &info) {
  uint32_t n = (uint32_t)inflight_.count;
  for (id<MTLCommandBuffer> c in inflight_) [c waitUntilCompleted];
  [inflight_ removeAllObjects];
  return Napi::Number::New(info.Env(), n);
}

Napi::Value DirectServer::GetHasClients(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(info.Env(), server_ ? server_.hasClients : false);
}

Napi::Value DirectServer::GetName(const Napi::CallbackInfo &info) {
  if (!server_) return info.Env().Null();
  return Napi::String::New(info.Env(),
                           server_.name ? server_.name.UTF8String : "");
}

Napi::Object DirectServer::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(
      env, "DirectServer",
      {
          InstanceMethod("publishAtlas", &DirectServer::PublishAtlas),
          InstanceMethod("reap", &DirectServer::Reap),
          InstanceMethod("drain", &DirectServer::Drain),
          InstanceAccessor("name", &DirectServer::GetName, nullptr),
          InstanceMethod("dispose", &DirectServer::Dispose),
          InstanceAccessor("hasClients", &DirectServer::GetHasClients, nullptr),
      });
  exports.Set("DirectServer", func);
  return exports;
}

static Napi::Value ListServers(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Napi::Array out = Napi::Array::New(env);
  @autoreleasepool {
    NSArray *servers = [[SyphonServerDirectory sharedDirectory] servers];
    uint32_t i = 0;
    for (NSDictionary *s in servers) {
      Napi::Object o = Napi::Object::New(env);
      NSString *name = s[SyphonServerDescriptionNameKey];
      NSString *app = s[SyphonServerDescriptionAppNameKey];
      NSString *uuid = s[SyphonServerDescriptionUUIDKey];
      o.Set("name", Napi::String::New(env, name ? name.UTF8String : ""));
      o.Set("appName", Napi::String::New(env, app ? app.UTF8String : ""));
      o.Set("uuid", Napi::String::New(env, uuid ? uuid.UTF8String : ""));
      out.Set(i++, o);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
//  benchmarkScaling — measure how the publish path scales across MANY outputs,
//  the way a real app does (N offscreen windows → Syphon). Two patterns, sized
//  to publish the SAME total pixel area per frame so the comparison is fair:
//
//    'multi'     : cols*rows independent SyphonMetalServers, each with its own
//                  command queue + IOSurface (= the "one window, one server"
//                  pattern). One "frame" publishes a tile to every server.
//    'composite' : ONE server publishing a single (cols*w)×(rows*h) IOSurface
//                  (= the "one big window, tiled regions, one server" pattern).
//                  One "frame" is a single publish of the whole grid.
//
//  Reported avgMs is wall-clock per FULL-GRID frame (all tiles updated once),
//  so lower = the whole multi-output workflow runs faster.
// ---------------------------------------------------------------------------
static IOSurfaceRef MakeFilledSurface(NSUInteger w, NSUInteger h) {
  NSDictionary *props = @{
    (id)kIOSurfaceWidth : @(w),
    (id)kIOSurfaceHeight : @(h),
    (id)kIOSurfaceBytesPerElement : @(4),
    (id)kIOSurfacePixelFormat : @((uint32_t)'BGRA'),
  };
  IOSurfaceRef s = IOSurfaceCreate((__bridge CFDictionaryRef)props);
  if (!s) return nullptr;
  IOSurfaceLock(s, 0, nullptr);
  memset(IOSurfaceGetBaseAddress(s), 0x80, IOSurfaceGetAllocSize(s));
  IOSurfaceUnlock(s, 0, nullptr);
  return s;
}

static id<MTLTexture> WrapSurface(id<MTLDevice> dev, IOSurfaceRef s,
                                  NSUInteger w, NSUInteger h) {
  MTLTextureDescriptor *desc = [MTLTextureDescriptor
      texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                   width:w
                                  height:h
                               mipmapped:NO];
  desc.usage = MTLTextureUsageShaderRead;
  desc.storageMode = MTLStorageModeShared;
  return [dev newTextureWithDescriptor:desc iosurface:s plane:0];
}

static Napi::Value BenchmarkScaling(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Napi::Object opts = (info.Length() > 0 && info[0].IsObject())
                          ? info[0].As<Napi::Object>()
                          : Napi::Object::New(env);
  auto numOr = [&](const char *k, uint32_t d) -> uint32_t {
    return opts.Has(k) ? opts.Get(k).ToNumber().Uint32Value() : d;
  };
  const NSUInteger tileW = numOr("width", 1280);
  const NSUInteger tileH = numOr("height", 720);
  const uint32_t cols = numOr("cols", 4);
  const uint32_t rows = numOr("rows", 4);
  const uint32_t iterations = numOr("iterations", 200);
  const bool wait = opts.Has("wait") ? opts.Get("wait").ToBoolean().Value() : false;
  const BOOL flipped = opts.Has("flip")
                           ? (opts.Get("flip").ToBoolean().Value() ? YES : NO)
                           : YES;
  std::string mode =
      opts.Has("mode") ? opts.Get("mode").ToString().Utf8Value() : "multi";
  const uint32_t n = cols * rows;

  id<MTLDevice> dev = MTLCreateSystemDefaultDevice();
  if (!dev) {
    Napi::Error::New(env, "No Metal device").ThrowAsJavaScriptException();
    return env.Null();
  }

  double total = 0.0;
  @autoreleasepool {
    if (mode == "directflip") {
      // Like 'direct', but composites WITH a vertical flip in a single render
      // pass straight into the server's surface — so the zero-copy path can serve
      // flipY=true. Compare vs 'atlas' (which flips via Syphon's separate copy):
      // this is one pass (~2x area) vs atlas-flipped's two (~4x area).
      const NSUInteger aw = tileW * cols, ah = tileH * rows;
      std::vector<IOSurfaceRef> surfs(n, nullptr);
      std::vector<id<MTLTexture>> texs(n, nil);
      for (uint32_t k = 0; k < n; k++) {
        surfs[k] = MakeFilledSurface(tileW, tileH);
        texs[k] = WrapSurface(dev, surfs[k], tileW, tileH);
      }
      // outputScale: publish the whole composite at a fraction of native size.
      // The render pass already samples each source, so downscaling into a
      // smaller surface is nearly free and shrinks the write + the surface a
      // consumer reads — for walls displayed smaller than their native res.
      double oscale = opts.Has("outputScale") ? opts.Get("outputScale").ToNumber().DoubleValue() : 1.0;
      if (oscale <= 0 || oscale > 1) oscale = 1.0;
      const NSUInteger ow = MAX((NSUInteger)1, (NSUInteger)llround(aw * oscale));
      const NSUInteger oh = MAX((NSUInteger)1, (NSUInteger)llround(ah * oscale));
      id<MTLCommandQueue> q = [dev newCommandQueue];
      DirectSyphonServer *srv =
          [[DirectSyphonServer alloc] initWithName:@"scaling-directflip" options:nil];
      IOSurfaceRef pub = [srv newSurfaceForWidth:ow height:oh options:nil];
      if (!pub) { Napi::Error::New(env, "newSurfaceForWidth failed").ThrowAsJavaScriptException(); return env.Null(); }
      // Render target view of the server surface (BGRA8 color attachment).
      MTLTextureDescriptor *rd = [MTLTextureDescriptor
          texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                       width:ow height:oh mipmapped:NO];
      rd.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
      rd.storageMode = MTLStorageModeShared;
      id<MTLTexture> dst = [dev newTextureWithDescriptor:rd iosurface:pub plane:0];

      NSError *err = nil;
      NSString *msl =
          @"#include <metal_stdlib>\n using namespace metal;\n"
          @"struct VOut { float4 pos [[position]]; float2 uv; };\n"
          @"vertex VOut vmain(uint vid [[vertex_id]]) {\n"
          @"  float2 p[4] = { float2(-1,-1), float2(1,-1), float2(-1,1), float2(1,1) };\n"
          @"  float2 uv[4] = { float2(0,1), float2(1,1), float2(0,0), float2(1,0) };\n" // V flipped
          @"  VOut o; o.pos = float4(p[vid],0,1); o.uv = uv[vid]; return o; }\n"
          @"fragment float4 fmain(VOut in [[stage_in]], texture2d<float> t [[texture(0)]]) {\n"
          @"  constexpr sampler s(filter::nearest); return t.sample(s, in.uv); }\n";
      id<MTLLibrary> lib = [dev newLibraryWithSource:msl options:nil error:&err];
      if (!lib) { Napi::Error::New(env, "shader compile failed").ThrowAsJavaScriptException(); return env.Null(); }
      MTLRenderPipelineDescriptor *pd = [[MTLRenderPipelineDescriptor alloc] init];
      pd.vertexFunction = [lib newFunctionWithName:@"vmain"];
      pd.fragmentFunction = [lib newFunctionWithName:@"fmain"];
      pd.colorAttachments[0].pixelFormat = MTLPixelFormatBGRA8Unorm;
      id<MTLRenderPipelineState> pso = [dev newRenderPipelineStateWithDescriptor:pd error:&err];
      if (!pso) { Napi::Error::New(env, "pipeline failed").ThrowAsJavaScriptException(); return env.Null(); }

      __weak DirectSyphonServer *wsrv = srv;
      NSMutableArray<id<MTLCommandBuffer>> *flight = [NSMutableArray array];
      // loadAction: 'load' preserves unchanged tiles (needed for partial
      // updates); 'dontcare' skips reading the surface — valid when every pixel
      // is overwritten this pass (full update), saving a whole-surface read.
      const bool dontCare =
          opts.Has("load") && opts.Get("load").ToString().Utf8Value() == "dontcare";
      // dirtyPerFrame: redraw only this many tiles/frame (loadAction=Load keeps
      // the rest). Measures the partial-update path the way a sparse wall hits it.
      const uint32_t dirty =
          opts.Has("dirtyPerFrame")
              ? MIN(n, (uint32_t)opts.Get("dirtyPerFrame").ToNumber().Uint32Value())
              : n;
      uint32_t base = 0;
      auto buildFrame = [&](BOOL doWait, uint32_t nDraw) {
        id<MTLCommandBuffer> c = [q commandBuffer];
        MTLRenderPassDescriptor *rp = [MTLRenderPassDescriptor renderPassDescriptor];
        rp.colorAttachments[0].texture = dst;
        rp.colorAttachments[0].loadAction =
            dontCare ? MTLLoadActionDontCare : MTLLoadActionLoad;
        rp.colorAttachments[0].storeAction = MTLStoreActionStore;
        id<MTLRenderCommandEncoder> enc = [c renderCommandEncoderWithDescriptor:rp];
        [enc setRenderPipelineState:pso];
        for (uint32_t j = 0; j < nDraw; j++) {
          uint32_t k = (base + j) % n;
          double cx = (k % cols) * tileW * oscale, cy = (k / cols) * tileH * oscale;
          [enc setViewport:(MTLViewport){cx, cy, tileW * oscale, tileH * oscale, 0, 1}];
          [enc setFragmentTexture:texs[k] atIndex:0];
          [enc drawPrimitives:MTLPrimitiveTypeTriangleStrip vertexStart:0 vertexCount:4];
        }
        base = (base + nDraw) % n;
        [enc endEncoding];
        [c addCompletedHandler:^(id<MTLCommandBuffer> _Nonnull) { [wsrv publish]; }];
        [c commit];
        if (doWait) [c waitUntilCompleted];
        else [flight addObject:c];
      };
      buildFrame(YES, n);
      double t0 = NowMs();
      for (uint32_t i = 0; i < iterations; i++) {
        buildFrame(wait ? YES : NO, dirty);
        if (!wait) {
          while (flight.count > 0 &&
                 (flight[0].status == MTLCommandBufferStatusCompleted ||
                  flight[0].status == MTLCommandBufferStatusError))
            [flight removeObjectAtIndex:0];
        }
      }
      for (id<MTLCommandBuffer> c in flight) [c waitUntilCompleted];
      total = NowMs() - t0;
      [srv stop];
      CFRelease(pub);
      for (uint32_t k = 0; k < n; k++) if (surfs[k]) CFRelease(surfs[k]);
    } else if (mode == "direct") {
      // ZERO-COPY composite: blit the N source tiles DIRECTLY into the server's
      // own published IOSurface (via SyphonSubclassing) and call -publish. Skips
      // SyphonMetalServer's internal copy of our atlas — one full blit instead of
      // two. Async: -publish fires in the command-buffer completion handler so
      // clients only see the surface after the GPU finishes writing it.
      const NSUInteger aw = tileW * cols, ah = tileH * rows;
      std::vector<IOSurfaceRef> surfs(n, nullptr);
      std::vector<id<MTLTexture>> texs(n, nil);
      for (uint32_t k = 0; k < n; k++) {
        surfs[k] = MakeFilledSurface(tileW, tileH);
        texs[k] = WrapSurface(dev, surfs[k], tileW, tileH);
      }
      id<MTLCommandQueue> q = [dev newCommandQueue];
      DirectSyphonServer *srv =
          [[DirectSyphonServer alloc] initWithName:@"scaling-direct" options:nil];
      IOSurfaceRef pub = [srv newSurfaceForWidth:aw height:ah options:nil];
      if (!pub) {
        Napi::Error::New(env, "newSurfaceForWidth failed (SyphonSubclassing)")
            .ThrowAsJavaScriptException();
        return env.Null();
      }
      id<MTLTexture> dst = WrapSurface(dev, pub, aw, ah);
      __weak DirectSyphonServer *wsrv = srv;
      NSMutableArray<id<MTLCommandBuffer>> *flight = [NSMutableArray array];
      auto buildFrame = [&](BOOL doWait) {
        id<MTLCommandBuffer> c = [q commandBuffer];
        id<MTLBlitCommandEncoder> blit = [c blitCommandEncoder];
        for (uint32_t k = 0; k < n; k++) {
          NSUInteger cx = (k % cols) * tileW, cy = (k / cols) * tileH;
          [blit copyFromTexture:texs[k]
                    sourceSlice:0 sourceLevel:0
                   sourceOrigin:MTLOriginMake(0, 0, 0)
                     sourceSize:MTLSizeMake(tileW, tileH, 1)
                      toTexture:dst
               destinationSlice:0 destinationLevel:0
              destinationOrigin:MTLOriginMake(cx, cy, 0)];
        }
        [blit endEncoding];
        [c addCompletedHandler:^(id<MTLCommandBuffer> _Nonnull) {
          [wsrv publish];
        }];
        [c commit];
        if (doWait) [c waitUntilCompleted];
        else [flight addObject:c];
      };
      buildFrame(YES); // warm up
      double t0 = NowMs();
      for (uint32_t i = 0; i < iterations; i++) {
        buildFrame(wait ? YES : NO);
        if (!wait) {
          while (flight.count > 0 &&
                 (flight[0].status == MTLCommandBufferStatusCompleted ||
                  flight[0].status == MTLCommandBufferStatusError))
            [flight removeObjectAtIndex:0];
        }
      }
      for (id<MTLCommandBuffer> c in flight) [c waitUntilCompleted];
      total = NowMs() - t0;
      [srv stop];
      CFRelease(pub);
      for (uint32_t k = 0; k < n; k++) if (surfs[k]) CFRelease(surfs[k]);
    } else if (mode == "composite") {
      const NSUInteger w = tileW * cols, h = tileH * rows;
      IOSurfaceRef surf = MakeFilledSurface(w, h);
      id<MTLTexture> tex = WrapSurface(dev, surf, w, h);
      id<MTLCommandQueue> q = [dev newCommandQueue];
      SyphonMetalServer *srv =
          [[SyphonMetalServer alloc] initWithName:@"scaling-composite"
                                           device:dev
                                          options:nil];
      NSRect region = NSMakeRect(0, 0, w, h);
      // warm up
      { id<MTLCommandBuffer> c = [q commandBuffer];
        [srv publishFrameTexture:tex onCommandBuffer:c imageRegion:region flipped:flipped];
        [c commit]; [c waitUntilCompleted]; }
      NSMutableArray<id<MTLCommandBuffer>> *flight = [NSMutableArray array];
      double t0 = NowMs();
      for (uint32_t i = 0; i < iterations; i++) {
        id<MTLCommandBuffer> c = [q commandBuffer];
        [srv publishFrameTexture:tex onCommandBuffer:c imageRegion:region flipped:flipped];
        [c commit];
        if (wait) [c waitUntilCompleted];
        else {
          [flight addObject:c];
          while (flight.count > 0 &&
                 (flight[0].status == MTLCommandBufferStatusCompleted ||
                  flight[0].status == MTLCommandBufferStatusError))
            [flight removeObjectAtIndex:0];
        }
      }
      for (id<MTLCommandBuffer> c in flight) [c waitUntilCompleted];
      total = NowMs() - t0;
      [srv stop];
      CFRelease(surf);
    } else if (mode == "atlas") {
      // Realistic composite: n separate source IOSurfaces (one per "window"),
      // blitted into ONE atlas texture on a single command buffer, then ONE
      // Syphon publish. This is what a shippable CompositeOutput would do.
      const NSUInteger aw = tileW * cols, ah = tileH * rows;
      std::vector<IOSurfaceRef> surfs(n, nullptr);
      std::vector<id<MTLTexture>> texs(n, nil);
      for (uint32_t k = 0; k < n; k++) {
        surfs[k] = MakeFilledSurface(tileW, tileH);
        texs[k] = WrapSurface(dev, surfs[k], tileW, tileH);
      }
      MTLTextureDescriptor *ad = [MTLTextureDescriptor
          texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                       width:aw
                                      height:ah
                                   mipmapped:NO];
      ad.usage = MTLTextureUsageShaderRead;
      std::string atlasStore = opts.Has("atlasStorage")
                                   ? opts.Get("atlasStorage").ToString().Utf8Value()
                                   : "private";
      ad.storageMode = atlasStore == "shared" ? MTLStorageModeShared
                                              : MTLStorageModePrivate;
      // hazardTracking: 'untracked' tells Metal to skip its automatic
      // read/write hazard synchronization on the atlas (we serialize via one
      // FIFO queue, so correctness holds) — measures whether the driver's
      // tracking costs anything on this path.
      std::string hazard = opts.Has("hazardTracking")
                               ? opts.Get("hazardTracking").ToString().Utf8Value()
                               : "tracked";
      if (hazard == "untracked")
        ad.hazardTrackingMode = MTLHazardTrackingModeUntracked;
      // atlasBuffers: 1 = one persistent atlas (a write-after-read hazard makes
      // next frame's blits wait for this frame's Syphon copy). N>=2 cycles
      // through N atlases so a frame writes a buffer no recent frame is still
      // reading — removes the hazard, lets the GPU overlap. Only valid when every
      // tile is rewritten each frame (full update).
      const uint32_t nbuf =
          opts.Has("atlasBuffers")
              ? MAX(1u, MIN(4u, (uint32_t)opts.Get("atlasBuffers").ToNumber().Uint32Value()))
              : 1;
      std::vector<id<MTLTexture>> bufs(nbuf, nil);
      for (uint32_t b = 0; b < nbuf; b++) bufs[b] = [dev newTextureWithDescriptor:ad];
      uint32_t bufIdx = 0;
      id<MTLTexture> atlas = bufs[0];
      id<MTLCommandQueue> q = [dev newCommandQueue];
      SyphonMetalServer *srv =
          [[SyphonMetalServer alloc] initWithName:@"scaling-atlas"
                                           device:dev
                                          options:nil];
      // dirtyPerFrame: how many tiles change (re-blit) per published frame. The
      // persistent atlas keeps unchanged tiles, so a wall where only a few
      // windows repaint costs only those blits + one publish. Default = all.
      const uint32_t dirty =
          opts.Has("dirtyPerFrame")
              ? MIN(n, (uint32_t)opts.Get("dirtyPerFrame").ToNumber().Uint32Value())
              : n;
      NSRect region = NSMakeRect(0, 0, aw, ah);
      NSMutableArray<id<MTLCommandBuffer>> *flight = [NSMutableArray array];
      uint32_t base = 0;
      auto buildFrame = [&](BOOL doWait, uint32_t nBlit) {
        id<MTLTexture> target = atlas;
        id<MTLCommandBuffer> c = [q commandBuffer];
        id<MTLBlitCommandEncoder> blit = [c blitCommandEncoder];
        for (uint32_t j = 0; j < nBlit; j++) {
          uint32_t k = (base + j) % n; // rotate which tiles are "dirty"
          NSUInteger cx = (k % cols) * tileW, cy = (k / cols) * tileH;
          [blit copyFromTexture:texs[k]
                    sourceSlice:0 sourceLevel:0
                   sourceOrigin:MTLOriginMake(0, 0, 0)
                     sourceSize:MTLSizeMake(tileW, tileH, 1)
                      toTexture:target
               destinationSlice:0 destinationLevel:0
              destinationOrigin:MTLOriginMake(cx, cy, 0)];
        }
        base = (base + nBlit) % n;
        [blit endEncoding];
        [srv publishFrameTexture:target onCommandBuffer:c imageRegion:region flipped:flipped];
        [c commit];
        if (doWait) [c waitUntilCompleted];
        else [flight addObject:c];
        if (nbuf > 1) { bufIdx = (bufIdx + 1) % nbuf; atlas = bufs[bufIdx]; } // cycle
      };
      for (uint32_t b = 0; b < nbuf; b++) buildFrame(YES, n); // fill every buffer once
      double t0 = NowMs();
      for (uint32_t i = 0; i < iterations; i++) {
        buildFrame(wait ? YES : NO, dirty);
        if (!wait) {
          while (flight.count > 0 &&
                 (flight[0].status == MTLCommandBufferStatusCompleted ||
                  flight[0].status == MTLCommandBufferStatusError))
            [flight removeObjectAtIndex:0];
        }
      }
      for (id<MTLCommandBuffer> c in flight) [c waitUntilCompleted];
      total = NowMs() - t0;
      [srv stop];
      for (uint32_t k = 0; k < n; k++) if (surfs[k]) CFRelease(surfs[k]);
    } else {
      // 'multi': n independent servers, queues, surfaces.
      NSMutableArray<SyphonMetalServer *> *servers = [NSMutableArray array];
      NSMutableArray<id<MTLCommandQueue>> *queues = [NSMutableArray array];
      std::vector<IOSurfaceRef> surfs(n, nullptr);
      std::vector<id<MTLTexture>> texs(n, nil);
      NSMutableArray<id<MTLCommandBuffer>> *flight = [NSMutableArray array];
      for (uint32_t k = 0; k < n; k++) {
        surfs[k] = MakeFilledSurface(tileW, tileH);
        texs[k] = WrapSurface(dev, surfs[k], tileW, tileH);
        [queues addObject:[dev newCommandQueue]];
        NSString *nm = [NSString stringWithFormat:@"scaling-multi-%u", k];
        [servers addObject:[[SyphonMetalServer alloc] initWithName:nm
                                                            device:dev
                                                           options:nil]];
      }
      NSRect region = NSMakeRect(0, 0, tileW, tileH);
      // warm up: one frame to each server
      for (uint32_t k = 0; k < n; k++) {
        id<MTLCommandBuffer> c = [queues[k] commandBuffer];
        [servers[k] publishFrameTexture:texs[k] onCommandBuffer:c imageRegion:region flipped:flipped];
        [c commit]; [c waitUntilCompleted];
      }
      double t0 = NowMs();
      for (uint32_t i = 0; i < iterations; i++) {
        for (uint32_t k = 0; k < n; k++) {
          id<MTLCommandBuffer> c = [queues[k] commandBuffer];
          [servers[k] publishFrameTexture:texs[k] onCommandBuffer:c imageRegion:region flipped:flipped];
          [c commit];
          if (wait) [c waitUntilCompleted];
          else [flight addObject:c];
        }
        if (!wait) {
          while (flight.count > 0 &&
                 (flight[0].status == MTLCommandBufferStatusCompleted ||
                  flight[0].status == MTLCommandBufferStatusError))
            [flight removeObjectAtIndex:0];
        }
      }
      for (id<MTLCommandBuffer> c in flight) [c waitUntilCompleted];
      total = NowMs() - t0;
      for (SyphonMetalServer *s in servers) [s stop];
      for (uint32_t k = 0; k < n; k++) if (surfs[k]) CFRelease(surfs[k]);
    }
  }

  const double avg = total / iterations;        // per full-grid frame
  const double perTile = avg / (cols * rows);    // per individual output
  const double mp = (double)tileW * tileH * cols * rows / 1e6;
  Napi::Object out = Napi::Object::New(env);
  out.Set("mode", Napi::String::New(env, mode));
  out.Set("tileWidth", Napi::Number::New(env, tileW));
  out.Set("tileHeight", Napi::Number::New(env, tileH));
  out.Set("cols", Napi::Number::New(env, cols));
  out.Set("rows", Napi::Number::New(env, rows));
  out.Set("outputs", Napi::Number::New(env, n));
  out.Set("iterations", Napi::Number::New(env, iterations));
  out.Set("wait", Napi::Boolean::New(env, wait));
  out.Set("flip", Napi::Boolean::New(env, flipped == YES));
  out.Set("totalMs", Napi::Number::New(env, total));
  out.Set("avgMs", Napi::Number::New(env, avg));
  out.Set("perTileMs", Napi::Number::New(env, perTile));
  out.Set("fps", Napi::Number::New(env, avg > 0 ? 1000.0 / avg : 0.0));
  out.Set("totalMegapixels", Napi::Number::New(env, mp));
  out.Set("throughputGBps",
          Napi::Number::New(env, mp * 1e6 * 4.0 * iterations / (total / 1000.0) / 1e9));
  return out;
}

// Test-only: create a solid-color BGRA IOSurface and return a Buffer holding its
// IOSurfaceRef pointer (the same handle shape Electron's paint event delivers),
// so JS tests can exercise publishAtlas without an Electron renderer. The Buffer
// keeps a +1 retain on the surface and CFReleases it when GC'd.
static Napi::Value MakeTestSurface(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  const NSUInteger w = info[0].As<Napi::Number>().Uint32Value();
  const NSUInteger h = info[1].As<Napi::Number>().Uint32Value();
  const uint8_t r = info[2].As<Napi::Number>().Uint32Value();
  const uint8_t g = info[3].As<Napi::Number>().Uint32Value();
  const uint8_t b = info[4].As<Napi::Number>().Uint32Value();
  // Optional bottom-half color (args 5,6,7) for verifying vertical flip.
  const bool split = info.Length() >= 8;
  const uint8_t br = split ? info[5].As<Napi::Number>().Uint32Value() : r;
  const uint8_t bg = split ? info[6].As<Napi::Number>().Uint32Value() : g;
  const uint8_t bb = split ? info[7].As<Napi::Number>().Uint32Value() : b;
  NSDictionary *props = @{
    (id)kIOSurfaceWidth : @(w),
    (id)kIOSurfaceHeight : @(h),
    (id)kIOSurfaceBytesPerElement : @(4),
    (id)kIOSurfacePixelFormat : @((uint32_t)'BGRA'),
  };
  IOSurfaceRef s = IOSurfaceCreate((__bridge CFDictionaryRef)props);
  if (!s) {
    Napi::Error::New(env, "IOSurfaceCreate failed").ThrowAsJavaScriptException();
    return env.Null();
  }
  IOSurfaceLock(s, 0, nullptr);
  uint8_t *base = (uint8_t *)IOSurfaceGetBaseAddress(s);
  const size_t bpr = IOSurfaceGetBytesPerRow(s);
  for (NSUInteger y = 0; y < h; y++) {
    uint8_t *row = base + y * bpr;
    const bool bottom = y >= h / 2; // row 0 = top in IOSurface memory order
    const uint8_t rr = bottom ? br : r, gg = bottom ? bg : g, bbl = bottom ? bb : b;
    for (NSUInteger x = 0; x < w; x++) {
      row[x * 4 + 0] = bbl;
      row[x * 4 + 1] = gg;
      row[x * 4 + 2] = rr;
      row[x * 4 + 3] = 255;
    }
  }
  IOSurfaceUnlock(s, 0, nullptr);
  // Copy the pointer bytes into a normal (non-external) Buffer — Electron forbids
  // external buffers. The surface is intentionally leaked (test-only, short-lived
  // process); the +1 retain from IOSurfaceCreate keeps it alive for the run.
  return Napi::Buffer<uint8_t>::Copy(env, reinterpret_cast<uint8_t *>(&s),
                                     sizeof(IOSurfaceRef));
}

static Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  SyphonServer::Init(env, exports);
  SyphonClient::Init(env, exports);
  DirectServer::Init(env, exports);
  exports.Set("listServers", Napi::Function::New(env, ListServers));
  exports.Set("benchmarkScaling", Napi::Function::New(env, BenchmarkScaling));
  exports.Set("__makeTestSurface", Napi::Function::New(env, MakeTestSurface));
  return exports;
}

NODE_API_MODULE(syphon_addon, InitAll)
