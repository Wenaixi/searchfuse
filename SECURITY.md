# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub Security Advisories: go to the repository's
**Security** tab and choose **Report a vulnerability**. That opens a private
channel with the maintainers. We aim to acknowledge a report within a few days.

Helpful things to include: the affected version (`searchfuse --version`), the URL
or input that triggers it, and the smallest reproduction you can manage.

## Scope

The most sensitive surface is the local `http` fetch engine, which makes requests
to URLs an agent may have pulled from untrusted page content. Its SSRF guards,
the one known DNS-rebinding gap, and how untrusted content is handled are
summarised here. Read this first: a report about the already-documented rebinding
window is not a new finding.

### What is already guarded

- Private and reserved address ranges are blocked unless `allowPrivateNetwork`
  is on, and that switch never authorises disclosure to the Firecrawl cloud: a
  private target written literally in the URL is never sent upstream under any
  configuration.
- The DNS answer is resolved once and the connection is pinned to the IP that
  passed the check, while the Host header and TLS SNI keep the original hostname.
  Every redirect hop re-validates and re-pins.
- **Known gap:** the window between the check and the connect. Pinning closes
  most of it, but a resolver that answers differently between the two lookups is
  the residual risk. This is documented deliberately, not an oversight.
- Proxy fake-IP answers (`198.18.0.0/15`) are treated as placeholders. Literal
  URLs such as `http://198.18.0.5/` stay blocked when `allowPrivateNetwork` is
  off.

### Keys and outbound output

- Keys live in `~/.searchfuse/config.json` at mode 0600 in a 0700 directory.
  There is no keychain integration and no encryption at rest: file permissions
  plus the output boundaries below are the protection.
- `config show`, `doctor`, and the dsh settings card mask keys. Referenced
  external text (gateway error bodies, subprocess stderr) is scrubbed before
  reaching the terminal, `attempts`, `warnings`, or the cooldown state file.
- Environment variables (`TAVILY_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`,
  `KEENABLE_API_KEY`, `ANYSEARCH_API_KEY`) override the file and are never
  written to disk.

### Untrusted page content

Fetched pages are data, never instructions. The local engine does not run
JavaScript, so a client-rendered page comes back as an empty shell and the
result says so in `uncertainty` rather than presenting the shell as content.
