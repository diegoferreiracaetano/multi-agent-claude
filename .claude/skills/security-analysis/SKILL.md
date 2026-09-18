---
description: Security-focused code review covering OWASP Top 10 vulnerabilities and secure coding practices
---

# Security Analysis

Expert in identifying exploitable weaknesses and unsafe patterns, mapped to the OWASP Top 10.

## Injection

- SQL/NoSQL queries built via string concatenation or template literals with unsanitized input
- Command injection via `exec`/`spawn` with shell interpolation of user input
- Unsafe `eval()`, `new Function()`, or dynamic `require()`/`import()` of user-controlled paths

## Broken Access Control

- Missing authorization checks before mutating or returning another user's data
- Trusting client-supplied IDs/roles without server-side verification
- Path traversal via unsanitized file paths (`../`) in file read/write operations

## Cryptographic Failures

- Hardcoded secrets, API keys, or credentials in source
- Weak hashing (MD5/SHA1) for passwords instead of bcrypt/argon2/scrypt
- Predictable randomness (`Math.random()`) used for tokens, IDs, or secrets

## Injection via Web Surface

- XSS: unescaped user input rendered into HTML/DOM (`innerHTML`, template interpolation)
- SSRF: outbound requests built from user-supplied URLs without an allowlist
- Insecure deserialization of untrusted JSON/YAML into objects that drive behavior

## Data Exposure & Logging

- Sensitive data (passwords, tokens, PII) written to logs or error messages
- Stack traces or internal error details returned to clients
- Secrets read from `.env` but echoed in console output or committed defaults

## Dependency & Config Risks

- Outdated or known-vulnerable packages referenced without justification
- Overly permissive CORS (`*` with credentials) or disabled TLS verification
- Missing input validation at trust boundaries (API handlers, MCP tool inputs)

## Output:

For each finding provide:
1. Vulnerability class (map to an OWASP Top 10 category where applicable)
2. Concrete exploit scenario (what an attacker could do)
3. Fix with a corrected code snippet
4. Severity level (critical/high/medium/low/info)
