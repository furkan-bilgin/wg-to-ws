You are a security auditor. Review the wg-to-ws project for security vulnerabilities, design flaws, and operational risks.

Read ALL source files and the README, then produce a structured audit report.

---

## Read these files first

src/shared.ts
src/server.ts
src/client.ts
src/index.ts
README.md
PLAN.md
test/integration.sh

## Analyze these categories

1. **Data confidentiality** — Is WireGuard key material or traffic exposed at any point in the tunnel?
2. **Authentication & authorization** — Can an attacker connect to the server and inject/read traffic?
3. **Input validation** — Are WebSocket messages, UDP datagrams, or env vars validated?
4. **Denial of service** — What happens under high load, many connections, or malformed input?
5. **Network security** — Are there any IP/port binding issues, source-spoofing risks, or information leaks?
6. **Dependency / supply chain** — Are there external dependencies with known vulnerabilities?
7. **Operational security** — Logging of sensitive data, graceful shutdown, reconnection risks.

## Output format

Write the report to `SECURITY.md` in the project root.

Use this structure:

```markdown
# Security Audit — wg-to-ws

## Summary
[risk level: low / medium / high / critical]

## Findings

### [F-001] Title
- **Severity:** low | medium | high | critical
- **Location:** file.ts:line
- **Description:**
- **Impact:**
- **Recommendation:**

...

## Conclusion
```

Be specific. Reference exact file names and line numbers. If something is fine, say so explicitly.
