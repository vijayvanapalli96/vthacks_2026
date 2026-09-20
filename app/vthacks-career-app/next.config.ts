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
   * THE PRESAGE SDK HAS TO BE TRACED IN BY HAND.
   *
   * src/lib/presage.ts imports `@smartspectra/node-sdk` through a VARIABLE
   * specifier, deliberately, so the bundler cannot try to resolve a package whose
   * payload is native and platform-specific. The cost of that trick is that Next's
   * standalone file tracing cannot see the dependency either — so without this the
   * deployed image would not contain it, and the steadiness read would be off in
   * production while working perfectly in dev. That is the worst kind of bug: it
   * only appears where nobody is watching.
   *
   * `serverExternalPackages` keeps it out of the server bundle (it loads native
   * `.node` payloads, which webpack cannot process), and the tracing include puts
   * the files in the image.
   */
  serverExternalPackages: ['@smartspectra/node-sdk'],
  outputFileTracingIncludes: {
    // Keyed on '**' rather than the vitals route. The key is matched against the
    // route identifier Next uses internally, and getting that string subtly wrong
    // fails OPEN: the build succeeds and the files are simply absent. A wildcard
    // costs nothing here because the standalone output has one shared node_modules
    // tree, so the package is copied once however many routes name it.
    // The LINUX payloads only. The package publishes one native payload per
    // platform and `npm ci` in the image installs just the matching one, but a
    // build run on a developer's machine would otherwise trace all four into the
    // bundle — about 250 MB of macOS and Windows binaries that can never execute
    // in a Debian container.
    '**': [
      './node_modules/@smartspectra/node-sdk/**',
      './node_modules/@smartspectra/node-sdk-linux-x64/**',
      './node_modules/@smartspectra/node-sdk-linux-arm64/**',
    ],
  },
};
export default nextConfig;
