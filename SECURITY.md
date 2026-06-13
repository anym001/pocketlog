# Security Policy

PocketLog stores personal financial data and is designed for private
self-hosting. Security reports are taken seriously.

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub
issues, discussions, or pull requests.

Instead, use GitHub's **private vulnerability reporting**:

1. Open the [**Security**](https://github.com/anym001/pocketlog/security)
   tab of this repository.
2. Click **"Report a vulnerability"** to open a private security advisory.

This keeps the report confidential between you and the maintainer until a fix
is available.

### What to include

- A description of the vulnerability and its impact
- Steps to reproduce (proof of concept, affected version, configuration —
  SQLite vs. MariaDB, reverse proxy, auth path)
- Any suggested mitigation, if known

### What to expect

- Acknowledgement of your report as soon as possible.
- An assessment and, where applicable, a fix released as a new version
  (`:X.Y.Z` image tag).
- Coordinated disclosure — please allow a reasonable window before any public
  disclosure.

### Please do not include real data

When sharing reproduction steps or logs, redact secrets (session/CSRF tokens,
API keys, password hashes, cookies) and use throwaway accounts — never real
financial data.

## Supported Versions

Security fixes are provided for the **latest released version** only. Always
run the most recent `:X.Y.Z` image tag.
