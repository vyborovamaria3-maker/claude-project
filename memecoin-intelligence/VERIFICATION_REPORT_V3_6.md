# Verification report v3.6

## Result

All mandatory checks that can run in the current environment passed.

### Passed
- 67 TypeScript/TSX files transpile without syntax diagnostics.
- 89 internal `@/` imports resolve to existing source files.
- 4 `.mjs` scripts pass `node --check`.
- API-key comparison behavior tests pass, including different-length keys.
- Legacy API-key compatibility and RBAC identity tests pass.
- Security headers preserve the legacy configuration when disabled and produce strict settings when enabled.
- RBAC role allow/deny tests pass.
- Post-build alias rewrite works on isolated emitted-JS fixtures.
- `docker-compose.yml`, `.env.example`, and `package.json` consistency checks pass.
- Qwen Python service passes `compileall`.
- Static scan found no SQL template-string interpolation matching SELECT/INSERT/UPDATE/DELETE statements.

### Environment-blocked checks
- Full `npm install`, `npm test`, `npm run typecheck`, and `npm run build` could not be completed because the configured npm registry returned HTTP 404 for `@fastify/cors`.
- Docker runtime/build checks could not be completed because the `docker` executable is unavailable in this environment.

These blocked checks are not reported as passed.

## Compatibility policy
- `SECURITY_HEADERS_STRICT=false` by default.
- `SECURITY_RBAC_ENABLED=false` by default.
- Existing `INTERNAL_API_KEY` behavior is retained when present.
- No JWT/OAuth or database user schema was introduced in this pass.
