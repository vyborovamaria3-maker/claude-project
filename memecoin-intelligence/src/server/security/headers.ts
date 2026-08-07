export type SecurityHeadersConfig = {
  strict: boolean;
  nodeEnv: 'development' | 'test' | 'production';
};

/**
 * Keep the legacy Helmet behavior unless strict security headers are explicitly
 * enabled. This makes the hardening opt-in and prevents accidental regressions.
 */
export function securityHeadersOptions(config: SecurityHeadersConfig) {
  if (!config.strict) {
    return { contentSecurityPolicy: false } as const;
  }

  return {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    hsts: config.nodeEnv === 'production'
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
      : false,
    frameguard: { action: 'deny' as const },
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' as const },
  };
}
