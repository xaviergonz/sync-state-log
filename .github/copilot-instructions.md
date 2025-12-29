# Copilot Instructions for yjs-proxy

This repository is a pnpm workspace + Turborepo monorepo. The main deliverable is the `yjs-proxy` package under `packages/yjs-proxy`.

## Overview

`yjs-proxy` provides proxy-based ergonomics for Yjs (CRDT): it lets users work with `Y.Map` and `Y.Array` like plain JS objects/arrays while keeping data in Yjs structures.

The library is careful about:
- Converting between JS values and Yjs values.
- Wrapping/unwrapping Yjs types via proxies.
- Proxy lifecycle and detachment (avoid stale proxies).
- Predictable behavior for arrays/maps, iteration, deletion, and assignment.

## Repository Structure

- `packages/yjs-proxy/src`: library source.
- `packages/yjs-proxy/test`: Vitest test suite.
- `packages/yjs-proxy/api-docs`: generated TypeDoc output.
- Root-level `README.md`, `LICENSE`, `CHANGELOG.md` are copied into the package on build.

## Tech Stack

- **Language**: TypeScript (strict).
- **Build**: Vite + `vite-plugin-dts` (outputs ESM + UMD).
- **Testing**: Vitest.
- **Lint/Format**: Biome.
- **Monorepo**: pnpm workspaces + Turborepo.
- **Runtime peer dependency**: `yjs`.

## Key Concepts (library-specific)

When changing code, keep these behaviors stable:
- **Conversion**: JS ↔ Yjs conversions live in `src/conversion.ts` / `src/toYjs.ts` and related helpers.
- **Proxy wrappers**: map/array proxies in `src/mapProxy.ts` and `src/arrayProxy.ts`.
- **Lifecycle/detachment**: detaching proxies from underlying Yjs values (`src/detachProxyOfYjsValue.ts`) must prevent use-after-detach bugs.
- **Unwrap/wrap**: `src/unwrapYjs.ts`, `src/wrapYjs.ts`, and `src/toYjsProxy.ts` define how values are surfaced to users.
- **Errors**: use typed errors in `src/error/*` (don’t throw raw strings).

## Commands

Use `pnpm`. Prefer running commands from the repo root.

### Root (recommended)

- `pnpm -w lint` — lint with Biome.
- `pnpm -w lib:build` — build the `yjs-proxy` package via Turbo.
- `pnpm -w lib:test` — run tests via Turbo. Might add `test test/<file>.test.ts` to target specific tests.
- `pnpm -w lib:test:ci` — run tests with coverage via Turbo.
- `pnpm -w lib:build-docs` — generate TypeDoc output via Turbo.

## Standards

- **Linting**: Biome is used for linting and formatting. Let it handle all formatting and linting concerns automatically. Always run `pnpm -w lint` before finishing a task.
- **Minimal, surgical changes**: Avoid refactors unless required by the task.
- **TypeScript**: keep types precise; prefer `unknown` over `any`.
- **Public API stability**: treat exports from `packages/yjs-proxy/src/index.ts` as public surface. Avoid breaking changes unless explicitly requested.
- **Build artifacts**: Don’t edit generated files in `dist/`, `api-docs/`, `coverage/`. Always change source and re-generate.
- Don’t bump package versions or publish to npm unless explicitly requested.
- Package root files (`README.md`, `LICENSE`, `CHANGELOG.md`, `logo.png`) are copied into each package during builds; update the root copies if you need to change them.
- Prefer making Yjs mutations inside a `doc.transact(() => { ... })` when doing multi-step updates (tests may be simpler, but library code should avoid surprising intermediate states).
- Avoid relying on Yjs private internals (`_map`, `_start`, Item structs, etc.). Prefer public Yjs APIs and existing helpers in this repo.
- Don’t import from `dist/` or generated type output; always work against `src/`.
- When adding new public functionality, export it intentionally from `packages/yjs-proxy/src/index.ts` (and avoid incidental exports).
- For bug fixes, add a regression test under `packages/yjs-proxy/test`.
- Prefer small, focused tests that reproduce the behavior and assert the exact outcome.
- If behavior differs between `Y.Map` and `Y.Array`, test both.
- When changing proxy/unwrap semantics, add tests for:
	- property reads/writes
	- deletion
	- iteration (`Object.keys`, `for...of`, etc. as applicable)
	- detachment (old proxy should fail or behave as designed)
- If the change affects user-facing behavior, update `README.md` and/or `CHANGELOG.md` at the repo root (the build copies them into the package).
- Prefer workspace commands (`pnpm ...` from root) over running package scripts directly, unless debugging a single package.
- Don’t add new dependencies unless necessary; prefer existing utilities already used in the repo.
