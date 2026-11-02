// 描画・点検の Chromium の起動の引数（1か所だけ）。3D の型（設計書の "webgl": true → WEBGL=1）は CPU の WebGL（SwiftShader）を使う
export const chromeArgs = (base) => [...base, ...(process.env.WEBGL ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] : [])];
