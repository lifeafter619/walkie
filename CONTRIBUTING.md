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

## Releasing

1. Bump the version in four places: `package.json`, `src/shared/version.ts`, `packages/walkie-cli/package.json`, `packages/walkie-mcp/package.json`. The two CLIs read their own `package.json` at runtime, so `--version` needs no separate edit.
2. Move the `[Unreleased]` entries in `CHANGELOG.md` under the new version.
3. `git tag -a v<x.y.z> -m "walkie v<x.y.z>" && git push origin v<x.y.z>`.

`.github/workflows/release.yml` then runs the test suite, refuses to publish if any version disagrees with the tag, skips versions already on the registry, and publishes both packages to npm with provenance. Credentials come from npm trusted publishing (GitHub Actions OIDC) — there is no npm token in this repository, and the trust is bound to this workflow's filename, so renaming it means reconfiguring it on npmjs.com.

Run the same workflow manually (`gh workflow run release.yml`) to check the trust configuration without publishing anything: it exchanges the OIDC token for each package and fails loudly if npm rejects it. Worth doing after touching the trusted publisher, because npm does not validate that configuration when you save it, and a broken exchange otherwise surfaces as a bare `401` at publish time.
