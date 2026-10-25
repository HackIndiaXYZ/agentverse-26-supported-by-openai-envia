# ADR 0001: Runtime Backend Interface and Host-Process Development Backend

## Status

Accepted for the first runtime foundation.

## Decision

Define a `RuntimeBackend` interface with a capability matrix. Implement a host-process backend for development and tests. Do not claim that it provides isolation. Require `isolationRequired: false` or an explicit unsafe override when using it for a jail.

## Consequences

- The platform can be developed and tested on hosts without OS container support.
- Security-sensitive jail creation fails closed on unsupported backends.
- A Linux-native backend can be added later without changing the CLI or state model.