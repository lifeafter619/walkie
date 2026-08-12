# Contributing

## Development

1. Use Node.js 22 or newer.
2. Run `npm ci`.
3. Run the API with `npm run dev` and Vite with `npm run dev:web`.
4. Before opening a pull request, run `npm test`, `npm run typecheck`, and `npm run build`.

## Adding a provider

1. Add the provider ID to `src/shared/types.ts`.
2. Add its public form definition and official documentation link in `src/server/providers/catalog.ts`.
3. Implement request construction in `src/server/providers/dispatcher.ts`.
4. Keep credentials inside the encrypted channel config. Never return them from an API.
5. Route configurable URLs through `safeFetch`; do not bypass SSRF checks.
6. Add a payload test in `tests/providers.test.ts` without contacting the real service.

Provider changes should document platform limits and use the platform's official API. Avoid adding a large SDK when a small documented HTTP request is sufficient.
