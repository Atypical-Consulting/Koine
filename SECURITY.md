# Security Policy

## Supported versions

Koine is pre-1.0 and under active development. Security fixes are applied to the latest released
`0.x` version and the `main` branch only.

| Version | Supported |
|---------|-----------|
| 0.17.x  | ✅        |
| < 0.17  | ❌        |

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Instead, report privately via GitHub's
[**Report a vulnerability**](https://github.com/Atypical-Consulting/Koine/security/advisories/new)
(Security → Advisories), or email **philippe@atypical.consulting** with:

- a description of the issue and its impact,
- a minimal `.koi` model or steps that reproduce it,
- any suggested remediation.

You can expect an acknowledgement within **5 business days**. We'll keep you informed as we work on a
fix and will credit you in the advisory unless you prefer to remain anonymous.

## Scope

Koine is a compiler that turns `.koi` models into source code. The most relevant classes of issue are:

- crashes, hangs, or excessive resource use in the parser/compiler on crafted input,
- generated code that is unsafe or does not match the declared model invariants.

Thank you for helping keep Koine and its users safe.
