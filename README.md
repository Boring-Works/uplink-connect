# Uplink Connect

Cloudflare-native data ingestion and collection platform built for reliability, observability, and scale. It handles multi-source ingestion workflows with durable execution guarantees.

## Current State
Active — Deployed on Cloudflare Workers. Core features like API intake, webhook receivers, durable coordination, workflows, entity normalization, and HTML dashboard are live. Browser rendering and email notifications are built but inactive.

## Tech Stack
TypeScript, Hono, Cloudflare Workers, Cloudflare D1, Cloudflare R2, Cloudflare Queues, Vectorize, Durable Objects.

## Key Dependencies
hono, ai, workers-ai-provider, zod, @uplink/contracts, @uplink/normalizers, @uplink/source-adapters

## Commands
- `pnpm install` — Install all dependencies
- `pnpm build` — Build all packages
- `pnpm dev:edge` — Run local edge service
- `pnpm dev:core` — Run local core service
- `pnpm dev:browser` — Run local browser service
- `pnpm dev:ops` — Run local ops service
- `pnpm test` — Run all test suites
- `cd apps/<app> && wrangler deploy` — Deploy individual workers to Cloudflare
