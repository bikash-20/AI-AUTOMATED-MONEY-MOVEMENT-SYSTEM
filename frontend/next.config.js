/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: "/api/:path*", destination: "http://127.0.0.1:8000/:path*" },
    ];
  },
  async headers() {
    // The face-api.js weights are ~4.4 MB and immutable once a particular
    // face-api.js release ships. Cache them aggressively so subsequent
    // page loads don't re-download. Bump the version path in lockstep
    // with a face-api.js upgrade.
    return [
      {
        source: "/models/face-api/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
  webpack: (config, { isServer }) => {
    // Node-only builtins + browser-only voice packages. These aliases
    // apply to BOTH server and client builds:
    //
    //   - onnxruntime-web / openwakeword-web / vad-web: pure browser
    //     packages. SSR never needs them, but Next.js still tries to
    //     resolve them transitively when tracing the client graph
    //     from the server build (serverComponentsExternalPackages
    //     doesn't help because they're already in node_modules at
    //     build time).
    //
    //   - node-fetch / fs / encoding: face-api.js transitively requires
    //     node-fetch via tfjs-core, which in turn requires Node builtins
    //     (`fs`, `encoding`, `path`). The face-api.js module's own
    //     `createFileSystem.js` also `require('fs')` at top level. If
    //     webpack doesn't stub these out for the client bundle, the
    //     emitted chunk contains `require('fs')` and explodes at
    //     runtime in the browser with a misleading
    //     `url.replace is not a function` (it's actually the failed
    //     module init that surfaces as a broken URL somewhere in
    //     React's internals). Aliasing them to `false` makes webpack
    //     substitute empty modules — which is fine because we never
    //     actually call into these code paths in the browser (the
    //     dynamic({ssr:false}) boundary ensures face-api.js only runs
    //     client-side, and in the browser it uses fetch + IDBFS
    //     instead of node-fetch + node-fs).
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "onnxruntime-web": false,
      "openwakeword-web": false,
      "openwakeword-web/microphone": false,
      "@ricky0123/vad-web": false,
      "node-fetch": false,
      fs: false,
      encoding: false,
      path: false,
      stream: false,
      zlib: false,
    };
    // Client-side: onnxruntime-web >= 1.20 ships an ESM bundle
    // (ort.bundle.min.mjs) that uses `import.meta`. Next.js's built-in
    // Terser pipeline (Terser 5 <5.39) cannot parse `import.meta` and
    // fails the build with "'import.meta' cannot be used outside of
    // module code." Mark these files as ESM so Terser treats them
    // correctly.
    if (!isServer) {
      config.module = config.module || {};
      config.module.rules = config.module.rules || [];
      config.module.rules.push({
        test: /\.m?js$/,
        include: /node_modules\/onnxruntime-web/,
        type: "javascript/esm",
      });
    }
    return config;
  },
};

module.exports = nextConfig;