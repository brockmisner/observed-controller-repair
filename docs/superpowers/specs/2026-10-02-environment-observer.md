# Environment lab and independent observer

The existing route player, RadioEngine, arrival lifecycle and per-image ADB registry remain authoritative. This addition supplies a real authenticated Android transport, a scoped **application test-state receiver**, and a separate Android API observer. It does not suppress mock indicators or implement device-wide Wi-Fi/cell/Bluetooth injection.

## Boundaries
- Lab receiver and observer are separate APK packages, ports and credentials. The lab receiver stages model frames for an owned application's test input, never claims Android radio application.
- Requests and responses are HMAC authenticated against a fresh per-connection nonce; image, boot, instance, session, sequence and epoch are checked. All sockets bind to phone loopback and are reached through an image-specific ADB forward.
- Receiver state is volatile, leased, session-owned and cleared on close, expiry or restart. Exact duplicate frames do not extend leases. Lower sequences, expired/foreign sessions and payload collisions are rejected.
- Observer samples Android APIs. Cached timestamps, missing permissions, missing hardware, redaction and unavailable measurements remain explicit. Mock-location status is retained. API observations do not prove physical RF or absence of third-party instrumentation.
- Controller routes require workspace authentication and device membership even when legacy auth is disabled. Tokens remain on disk and never reach browser responses or logs.
- Existing radio protocol v1 remains unchanged. This transport is named `stakeout.environment`, version 1, and is NOT an implementation of `duoplus.radio` v1.
- Production main and Railway are not deployed or modified by this build.

## Acceptance
Authentication/tampering, cross-image identity, fresh request IDs, cache age/future timestamps, connection timeout and cleanup, boot/instance changes, receiver replay/lease rules, two independent simulated devices, intent-versus-application labels and HTML escaping have automated checks. Android APK compilation is separate from phone verification. No actual DuoPlus device is considered verified without installation and signed readback.
