// Non-macOS stub. Syphon is macOS-only; on other platforms `require()` of the
// addon still succeeds, listServers() returns [], and SyphonServer methods
// no-op. (A future Windows build would expose Spout here behind the same API.)
#include <napi.h>

class SyphonServer : public Napi::ObjectWrap<SyphonServer> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(
        env, "SyphonServer",
        {
            InstanceMethod("publishSurface", &SyphonServer::Noop),
            InstanceMethod("publishSurfaceAsync", &SyphonServer::Zero),
            InstanceMethod("publishImageBuffer", &SyphonServer::Noop),
            InstanceMethod("reap", &SyphonServer::Zero),
            InstanceMethod("drain", &SyphonServer::Zero),
            InstanceMethod("benchmark", &SyphonServer::Noop),
            InstanceMethod("dispose", &SyphonServer::Noop),
            InstanceAccessor("name", &SyphonServer::GetName, nullptr),
            InstanceAccessor("hasClients", &SyphonServer::GetFalse, nullptr),
        });
    exports.Set("SyphonServer", func);
    return exports;
  }
  SyphonServer(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<SyphonServer>(info) {}

private:
  void Noop(const Napi::CallbackInfo &) {}
  Napi::Value Zero(const Napi::CallbackInfo &info) {
    return Napi::Number::New(info.Env(), 0);
  }
  Napi::Value GetName(const Napi::CallbackInfo &info) {
    return info.Env().Null();
  }
  Napi::Value GetFalse(const Napi::CallbackInfo &info) {
    return Napi::Boolean::New(info.Env(), false);
  }
};

static Napi::Value ListServers(const Napi::CallbackInfo &info) {
  return Napi::Array::New(info.Env());
}

class SyphonClient : public Napi::ObjectWrap<SyphonClient> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(
        env, "SyphonClient",
        {
            InstanceMethod("receive", &SyphonClient::ReceiveNoop),
            InstanceMethod("dispose", &SyphonClient::Noop),
            InstanceAccessor("isValid", &SyphonClient::GetFalse, nullptr),
            InstanceAccessor("hasNewFrame", &SyphonClient::GetFalse, nullptr),
        });
    exports.Set("SyphonClient", func);
    return exports;
  }
  SyphonClient(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<SyphonClient>(info) {}

private:
  void Noop(const Napi::CallbackInfo &) {}
  Napi::Value ReceiveNoop(const Napi::CallbackInfo &info) {
    Napi::Object o = Napi::Object::New(info.Env());
    o.Set("valid", Napi::Boolean::New(info.Env(), false));
    o.Set("hasFrame", Napi::Boolean::New(info.Env(), false));
    return o;
  }
  Napi::Value GetFalse(const Napi::CallbackInfo &info) {
    return Napi::Boolean::New(info.Env(), false);
  }
};

static Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  SyphonServer::Init(env, exports);
  SyphonClient::Init(env, exports);
  exports.Set("listServers", Napi::Function::New(env, ListServers));
  return exports;
}

NODE_API_MODULE(syphon_addon, InitAll)
