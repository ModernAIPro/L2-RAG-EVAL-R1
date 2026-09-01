import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // data/ is read at runtime with fs, not imported, so Next's dependency trace
  // cannot see it and would ship the chat function without an index. Naming the
  // route explicitly keeps the 8.6 MB out of every other function's bundle.
  outputFileTracingIncludes: {
    "/api/chat": ["./data/**/*"],
  },
};

export default nextConfig;
