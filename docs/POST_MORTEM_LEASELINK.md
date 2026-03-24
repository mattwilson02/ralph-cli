# Post-Mortem: LeaseLink Build

**Date:** March 22, 2026
**Sprints:** 19 (3 days)
**Stack:** NestJS API + Next.js Dashboard + Expo Mobile App
**Result:** Shipped and parked. All features working after manual audit and fixes.

## Overview

LeaseLink was Ralph's first full-stack proof-of-concept — a property management platform with Stripe payments, e-signatures, 2FA, audit logging, push notifications, and multi-role access. Ralph ran 19 sprints autonomously across 3 days. A comprehensive E2E manual audit on March 22 revealed ~15 bugs, all missed by automated verification.

## What Went Well

- **Volume and speed** — 19 sprints in 3 days. CRUD, state machines, domain logic, mappers, presenters, controllers, all wired up correctly.
- **Backend quality** — DDD architecture, Either error handling, proper domain modelling. Backend code was consistently solid.
- **Web frontend** — Adapted correctly to API contract changes. Dashboard worked end-to-end.
- **Spec-driven workflow** — Product spec → sprint spec → autonomous build → verify → PR. No human wrote code during sprints.

## What Broke

### The Core Problem: Cross-App Contract Seams

Sprint 18 standardised all API responses to `{ data: [...], meta: {...} }`. Ralph updated every web consumer. He updated zero mobile consumers. Every mobile list — payments, maintenance, documents, notifications — rendered empty. All automated checks passed.

This is the "Code as Story" seam problem. Ralph handles individual components well but fails at the boundaries between contract changes and their downstream consumers.

### Full Bug List

| # | Bug | Root Cause | Fix |
|---|-----|-----------|-----|
| 1 | PaymentList empty on mobile | `page.payments` → `page.data` | 1 line |
| 2 | MaintenanceRequestList empty on mobile | `page.maintenanceRequests` → `page.data` | 1 line |
| 3 | DocumentsList empty on mobile | `page.documents` → `page.data` | 1 line |
| 4 | NotificationsList empty on mobile | `page.notifications` → `page.data` | 1 line |
| 5 | Document detail shows no data | `data?.document` → `data?.data` | replace_all |
| 6 | Document preview not loading | `data?.document` → `data?.data` | replace_all |
| 7 | Sign document screen no data | `data?.document` → `data?.data` | replace_all |
| 8 | E-signature "Signing failed" | `Blob` from `Uint8Array` unsupported in RN | Use data URI fetch pattern |
| 9 | Notifications infinite scroll loops | offset/limit instead of page/pageSize | Rewrite pagination |
| 10 | Documents infinite scroll loops | Same pagination mismatch | Rewrite pagination |
| 11 | SIGN_DOCUMENT notification → upload flow | Wrong route in notification handler | Fix route mapping |
| 12 | Maintenance status shows "IN_PROGRESS" | Enum key instead of display label | Use MAINTENANCE_STATUS_LABELS |
| 13 | Maintenance notifications typed as ACTION | Should be INFO (status already changed) | Fix notification type |
| 14 | Payment received — no tenant notification | Only notified manager | Add tenant notification |
| 15 | Lease form validation flash on submit | `.uuid()` before `.min(1)`, no `onBlur` mode | Add `.min(1)` + `mode: "onBlur"` |

### Additional Issues (Web)

- Expense detail page: `data?.expense` → `data?.data`
- Expense edit page: same pattern
- Receipt image: rendering blob key as img src instead of generating download URL

## Failure Patterns

### 1. Consumer Discovery Failure
When Ralph changes an API contract, he doesn't systematically find and update ALL consumers across all apps. He updated web but not mobile. This is Ralph's biggest blind spot.

### 2. Platform-Unaware Code Generation
Ralph wrote `new Blob([byteArray], { type: 'image/png' })` for React Native. This is a Node/browser pattern that doesn't work in RN. He needs platform-specific awareness.

### 3. Pagination Inconsistency
Some components used offset/limit, others used page/pageSize. Ralph didn't enforce consistency when adapting to the new API contract format.

### 4. False Confidence from Green Checks
Every automated check passed — TypeScript compilation, unit tests, E2E tests, build checks. The bugs were all runtime data access issues that required actually using the app to discover.

## Vibe Coding Level Assessment

| Scope | Level | Description |
|-------|-------|-------------|
| Backend (isolated) | 4-5 | High autonomy. Spec in, working code out. |
| Full-stack (cross-app) | 3 | Human-in-the-loop mandatory. Ralph handles volume, human handles judgement. |

The original claim of Level 5 backend / Level 4 full-stack was revised after this audit. The gap between "automated tests pass" and "app actually works" is where human evaluation is still essential.

## Lessons for Ralph v2

### Must Fix
1. **Consumer discovery** — When an API contract changes, Ralph must find and update ALL consumers across all apps in the monorepo. Not just the ones in the current sprint's scope.
2. **Platform awareness** — Code generation must be platform-specific. React Native ≠ Node ≠ Browser.
3. **Cross-app regression checks** — Changes in shared contracts must trigger verification in every consumer app.

### Should Fix
4. **Pagination contract enforcement** — When standardising APIs, enforce the same pagination pattern everywhere.
5. **Runtime validation** — Some form of "does the data actually render" check beyond type-checking and unit tests.
6. **Notification contract validation** — When action types change, verify routing and display logic matches.

### Nice to Have
7. **Ralph Moments™** — Track and surface these failures as branded, shareable moments. Every crash gets a summary: "Classic Ralph."
8. **Consumer impact analysis** — Before a contract change, report which components will be affected across all apps.

## The Bottom Line

Ralph codes like a motivated junior — tireless, fast, earnest, but needs someone checking his work. The bottleneck isn't writing code or even writing specs. It's **evaluating output.** And that's still a human job.

The goal for Ralph v2: close this gap. Level 5 across full-stack, across multiple LLMs, across multiple languages. The LeaseLink build is the baseline we're measuring against.
