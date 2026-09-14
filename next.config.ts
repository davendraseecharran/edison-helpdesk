import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Local setup links use this loopback hostname as well as localhost.
  allowedDevOrigins: ['127.0.0.1'],
  logging: {
    // Setup/recovery callback URLs carry credentials; omit them from dev
    // request logs.
    incomingRequests: { ignore: [/\/auth\/confirm(?:\?|$)/] },
    // `next dev` otherwise prints every Server Function call with its
    // arguments, so `signInAction(email, password)` put a real app password in
    // plain text into the dev log (and into any transcript of it). Nothing in
    // this application needs that trace, and several actions take a secret:
    // sign-in, the password accounts panel, the assistant's API key. Off.
    // This is development-only logging; it changes nothing in production.
    serverFunctions: false,
  },
  reactStrictMode: true,
  experimental: {
    serverActions: {
      // A Server Action's request body is capped at 1 MB by default, which the
      // admin import would hit on the master inventory: 7,500 machines is a
      // couple of megabytes of CSV, sent as an argument to a Server Action.
      // The import refuses a file over 5 MB itself (MAX_CSV_BYTES), with a
      // sentence saying so; but the Server Action body is the CSV text PLUS
      // the column-mapping JSON alongside it, so a body limit equal to
      // MAX_CSV_BYTES would cut off a file already at the 5 MB cap before the
      // import's own, more useful refusal ever ran. One megabyte of headroom
      // for the mapping keeps the import's message the one the operator sees.
      bodySizeLimit: '6mb',
    },
  },
};

export default nextConfig;
