---
phase: uncommitted-changes
reviewed: 2026-08-18T09:22:27Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - solana-launcher/lib/landingDesign.ts
  - telegram-miniapp/frontend/src/App.tsx
  - telegram-miniapp/frontend/src/hooks/useTelegram.ts
  - telegram-miniapp/frontend/src/lib/telegram.ts
  - telegram-miniapp/frontend/src/index.css
  - telegram-miniapp/frontend/static/index.html
findings:
  critical: 2
  warning: 1
  info: 0
  total: 3
status: issues_found
---

# Phase uncommitted-changes: Code Review Report

**Reviewed:** 2026-08-18T09:22:27Z
**Depth:** standard
**Files Reviewed:** 6
**Status:** issues_found

## Summary

Focused review of the edited frontend files. The landing design tweak is cosmetic, but the Telegram Mini App changes introduce checkout breakage and drop the previous payment-confirmation path.

## Critical Issues

### CR-01: Checkout request is sent to the wrong contract

**File:** `telegram-miniapp/frontend/src/App.tsx:63-67`
**Issue:** The mini app now posts to a relative `/api/miniapp/create-invoice` URL and sends `currency`, while the backend checkout route expects an absolute backend origin and a `method` field. In this Vite app, that request will hit the frontend host and fail, and even if it reaches the backend the body is rejected.
**Fix:**
```ts
const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:3001';

await fetch(`${apiBase}/api/miniapp/create-invoice`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    initData: getTelegramInitData(),
    login: safeLogin,
    method,
  }),
});
```

### CR-02: Paid flow no longer completes, so credentials never arrive

**File:** `telegram-miniapp/frontend/src/App.tsx:71-85`
**Issue:** After opening the payment URL, the component stops. It no longer polls `/api/miniapp/verify-payment`, and the Telegram message it emits uses `action: 'payment'` instead of the bot's `payment_initiated` contract. Paying users will remain stuck on the "waiting" state with no credential handoff.
**Fix:**
```ts
sendData?.({ action: 'payment_initiated', method });
setCheckout({ payload: data.payload, ... });
// Keep polling verify-payment until it returns paid, then render login/password.
```

### CR-03: Auto-filled login can fail server validation for common Telegram profiles

**File:** `telegram-miniapp/frontend/src/App.tsx:66`
**Issue:** The fallback `user.first_name` is not constrained to the backend login regex. Telegram first names often contain spaces or non-ASCII characters, so `create-invoice` will return 400 for many users who do not have a username. The old manual login path avoided this.
**Fix:**
```ts
const safeLogin = user?.username || `tg_${user?.id ?? 'user'}`;
// or keep an editable login field and validate before submit
```

---

_Reviewed: 2026-08-18T09:22:27Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
