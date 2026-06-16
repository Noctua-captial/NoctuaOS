import type { NextConfig } from "next";

// A stray `package-lock.json` sits ABOVE this repo, so Next.js (which walks up
// looking for lockfiles) infers the wrong workspace root and warns. Pin both the
// Turbopack module-resolution root and the output-file-tracing root to this
// project dir to silence it locally and on Vercel. `process.cwd()` is the build
// invocation dir (= this repo for `next build`) and is an absolute path that
// resolves identically whether next.config.ts loads via the native ESM TS loader
// or the legacy CJS transpile path (unlike __dirname / import.meta.dirname, each
// of which exists in only one of those paths).
const projectRoot = process.cwd();

const nextConfig: NextConfig = {
  turbopack: {
    root: projectRoot,
  },
  outputFileTracingRoot: projectRoot,
};

export default nextConfig;
