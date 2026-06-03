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

static Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  SyphonServer::Init(env, exports);
  SyphonClient::Init(env, exports);
  exports.Set("listServers", Napi::Function::New(env, ListServers));
  return exports;
}

NODE_API_MODULE(syphon_addon, InitAll)
