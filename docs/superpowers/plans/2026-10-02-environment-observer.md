# Environment lab implementation plan

**Goal:** Deliver Android test-frame receipt and independent radio readback to the existing controller.
**Architecture:** Reuse RadioEngine and per-image player targets. Add a signed loopback protocol, two Android flavors and authenticated controller endpoints. Preserve production radio lifecycle until actual radio application exists.
**Tech stack:** Existing TypeScript/Node, Android Java, AGP 8.6.0 / Gradle 8.7 / SDK 34.
**Spec:** ../specs/2026-10-02-environment-observer.md

## Tasks
1. Test and implement protocol validation, HMAC request/response binding, bounded loopback client and freshness summaries.
2. Implement Android lab receiver with explicit lease/session/replay behavior and independent observer flavor with runtime permissions and cached API timestamps.
3. Connect through existing per-image ADB targets, credentials, workspace-scoped routes and existing device inspector. Add provisioning CLI; no automatic production deployment.
4. Add Wi-Fi visibility hysteresis and a separate arrival association intent policy; retain model-versus-application distinctions.
5. Run focused tests, full controller build/tests in CI, compile both APKs, package source and report actual verification status.

## Review focus
Wrong device credentials; altered HMAC payload; duplicate messages extending leases; stale or future location sample becoming fresh; observer permissions being represented as an empty scan.
