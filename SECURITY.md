# Security Policy

## Supported Versions

We release patches for security vulnerabilities. Which versions are eligible
receiving such patches depends on the CVSS v3.0 Rating:

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |
| latest release | :white_check_mark: |
| older releases | :x:                |

## Reporting a Vulnerability

Please report (suspected) security vulnerabilities privately through
[GitHub Security Advisories](https://github.com/different-ai-studio/teamclu/security/advisories/new).
Do not open a public issue for a vulnerability.

When reporting a vulnerability, please include:

- A description of the vulnerability
- Steps to reproduce the issue
- Possible impact of the vulnerability
- Any known mitigations or workarounds

You will receive a response from us within 48 hours. If the issue is confirmed,
we will release a patch as soon as possible depending on complexity.

## Security Best Practices

### For Users

- Keep your dependencies up to date
- Review code before running untrusted MCP servers
- Be cautious when granting file system permissions
- Report suspicious behavior immediately

### For Contributors

- Never commit sensitive data (API keys, passwords, etc.)
- Use environment variables for configuration
- Follow secure coding practices
- Review dependencies for known vulnerabilities

## Disclosure Policy

When we receive a security bug report, we will:

1. Confirm the vulnerability and determine affected versions
2. Audit code to find any similar problems
3. Prepare fixes for all supported versions
4. Release new versions and notify users
5. Publicly disclose the issue after 90 days or after a fix is released

## Security-Related Configuration

- All credentials should be stored in `.env` files (never committed)
- Use strong passwords and rotate them regularly
- Enable two-factor authentication for all accounts

## Known Security Issues

None at this time.

## Acknowledgments

We thank everyone who responsibly discloses security issues. Reporters are
credited in the advisory unless they ask not to be.
