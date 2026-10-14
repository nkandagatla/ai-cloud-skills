---
name: javascript-typescript
description: Company standard for JavaScript and TypeScript - strict tsconfig, ESLint/Prettier, module system (ESM), types over any, runtime validation with zod, async/await and error handling, immutability, testing with Vitest/Jest/Playwright, React/front-end safety, bundle size, and package management with npm/pnpm lockfiles. Use when writing, reviewing or refactoring JS/TS code in browsers or tooling.
---

# JavaScript and TypeScript

Load `engineering-guardrails`, `secure-coding` and `code-fundamentals` first. Server-side Node specifics are in `nodejs-backend`.

## 1. Project baseline

- TypeScript for anything beyond small scripts. `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  }
}
```
(Front-end apps using a bundler: `"module": "ESNext", "moduleResolution": "Bundler"`.)

- ESM (`"type": "module"`); no mixing `require` and `import` in new code.
- ESLint (flat config) with `typescript-eslint` recommended-type-checked, `eslint-plugin-security` for Node, Prettier for formatting. Lint must pass in CI.
- Package manager: whatever the lockfile says (`package-lock.json` → npm, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn). Use `npm ci` / `pnpm install --frozen-lockfile` in CI. Pin Node with `.nvmrc` / `engines`.

## 2. Code rules

- No `any`. Use `unknown` and narrow; generics for reusable code; `satisfies` for typed literals.
- Validate external data at runtime (requests, env, files, API responses) with `zod` (or `valibot`), and infer types from schemas:

```ts
import { z } from "zod";
const Env = z.object({ DATABASE_URL: z.string().url(), PORT: z.coerce.number().int().default(3000) });
export const env = Env.parse(process.env);   // fail fast at startup; never log env
```

- `const` by default; avoid mutation of shared objects; return new objects.
- `async/await` with `try/catch` at boundaries; never leave floating promises (`@typescript-eslint/no-floating-promises`); `Promise.all` for independent work, `Promise.allSettled` when partial failure is ok; `AbortController` timeouts for fetch.
- Errors: throw `Error` subclasses with `cause`; do not throw strings; do not swallow errors.
- Equality `===`; optional chaining and `??` instead of `||` for defaults that may be `0`/`""`.
- Dates: `Temporal` (where available) or `date-fns`/`luxon`; store UTC ISO strings.
- Money: integer minor units or a decimal library; never floating point.
- No `eval`, `new Function`, `setTimeout(string)`; no `innerHTML` with untrusted data.

## 3. Front-end (React and friends)

- Components small and typed; props interfaces exported; state lifted only as needed; server state via TanStack Query/SWR rather than ad-hoc effects.
- `useEffect` only for synchronising with external systems; clean up subscriptions.
- Never `dangerouslySetInnerHTML` without DOMPurify; never put secrets in client bundles (anything in `NEXT_PUBLIC_*` / `VITE_*` is public).
- Accessibility per `html-css`; `eslint-plugin-jsx-a11y`.
- Bundle budget: check with `vite build --report` / `next build` output; lazy-load routes; avoid huge deps (moment, lodash full).

## 4. Testing

- Unit/integration: Vitest (or Jest in existing repos); Testing Library for UI behaviour, not implementation details.
- E2E: Playwright with stable selectors (`getByRole`), no fixed sleeps.
- Mock at boundaries (HTTP with MSW), not internals.
- Commands with compact output (cheaper for agents): `npx vitest run --reporter=dot`, `npx jest --silent`, `npx playwright test --reporter=line`. Large outputs are trimmed by the `token-saver` hook.

## 5. Useful commands

```bash
npx tsc --noEmit -p .                 # type check
npx eslint . --max-warnings=0
npx prettier --check .
npm ls <pkg> --depth=0                # why is this installed
npm audit --omit=dev --audit-level=high
npx depcheck                          # unused deps
```

## Definition of done

Follow `code-fundamentals`. For JS/TS:

```bash
npx prettier --check . && npx eslint . --max-warnings=0 && npx tsc --noEmit
npx vitest run --coverage --reporter=dot      # thresholds set in vitest.config (lines/branches 80)
```

- ESLint with `typescript-eslint` strict-type-checked, `no-floating-promises`, `no-misused-promises`, `eqeqeq`, `complexity` (max 10), plus `eslint-plugin-security` / `jsx-a11y` where relevant.
- Every new or changed function or component with logic gets Vitest/Jest tests, including the rejected-promise path (`await expect(refund(id)).rejects.toThrow(RefundError)`).
- Errors: `try/catch` around awaited calls only where you can act; rethrow with `{ cause }`; `finally` for cleanup; no empty `catch {}`.

```ts
export async function loadOrder(id: string): Promise<Order> {
  try {
    const row = await repo.get(id);
    if (!row) throw new OrderNotFound(id);
    return OrderSchema.parse(row);
  } catch (err) {
    if (err instanceof OrderNotFound) throw err;
    throw new OrderStoreError(`load order ${id}`, { cause: err });
  }
}
```

## Never

- Use `any`, `// @ts-ignore` (use `@ts-expect-error` with a reason, sparingly), or disable lint rules file-wide.
- Commit `node_modules`, build output or `.env` files; put secrets in front-end bundles.
- Add dependencies for trivial helpers; install packages with uncertain names (typosquatting).
- `npm publish` from a laptop or agent (release through CI; guard asks).
- Add logic without a unit test that covers its error path, skip or weaken a failing test to get green, or swallow errors (see `code-fundamentals`).
