#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -d)"; trap 'rm -rf "$out"' EXIT
javac -d "$out" android/environment-observer/app/src/main/java/net/stakeout/environment/LabLease.java android/environment-observer/checks/LabLeaseChecks.java
java -cp "$out" net.stakeout.environment.LabLeaseChecks
