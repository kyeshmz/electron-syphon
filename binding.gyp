{
  "targets": [
    {
      "target_name": "syphon_addon",
      "sources": [ "native/syphon/syphon_addon.mm" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [ "NAPI_CPP_EXCEPTIONS" ],
      "conditions": [
        ['OS=="mac"', {
          "mac_framework_dirs": [
            "<!(pwd)/Frameworks"
          ],
          "libraries": [
            "Syphon.framework",
            "Metal.framework",
            "IOSurface.framework",
            "Foundation.framework",
            "QuartzCore.framework"
          ],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "GCC_ENABLE_CPP_RTTI": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "LD_RUNPATH_SEARCH_PATHS": [
              "<!(pwd)/Frameworks",
              "@loader_path/../../Frameworks",
              "@loader_path/../Frameworks",
              "@executable_path/../Frameworks"
            ]
          }
        }],
        ['OS!="mac"', {
          # Syphon is macOS-only. Elsewhere we compile a stub so require() works.
          "sources": [ "native/syphon/stub.cpp" ],
          "sources!": [ "native/syphon/syphon_addon.mm" ]
        }]
      ]
    }
  ]
}
