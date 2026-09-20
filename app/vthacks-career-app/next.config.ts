import path from 'node:path';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,

  /**
   * PIN THE TRACING ROOT TO THIS APP.
   *
   * Next infers the root from the nearest lockfile ABOVE the project, and a stray
   * package-lock.json in a home directory is enough to move it. Two things break
   * quietly when it does: the standalone bundle lands in a nested subdirectory (the
   * Dockerfile has a guard for exactly that), and every path in
   * outputFileTracingIncludes below resolves against the wrong directory, so the
   * files it names are silently not included. Pinning it makes a local build and a
   * container build agree.
   */
  outputFileTracingRoot: path.join(__dirname),

  /**
   * The Presage SDK is NOT bundled and NOT traced.
   *
   * src/lib/presage.ts imports it through a variable specifier so the bundler
   * cannot try to resolve a native, platform-specific payload. Next's file tracing
   * cannot see it for the same reason — and tracing it by hand does not work
   * either, because the SDK reaches `koffi` and `protobufjs` through plain
   * `require` at runtime and those are invisible to the tracer too. The first
   * attempt at this shipped @smartspectra without koffi and failed in production
   * with "Cannot find module 'koffi'" while working in dev.
   *
   * So the Dockerfile copies the whole subtree into the runner image instead, from
   * the deps stage where `npm ci` already resolved the correct platform payload.
   * One mechanism, verifiable with a single `node -e` inside the container.
   */
  serverExternalPackages: ['@smartspectra/node-sdk'],
};
export default nextConfig;
