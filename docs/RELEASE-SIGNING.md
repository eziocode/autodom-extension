# Release-Signing Runbook (maintainer-only)

This document explains how to mint the credentials the release pipeline needs
to publish self-hosted updates for AutoDOM. **Do this once, then never again
unless rotating.** Rotating any of these values changes the extension's
identity and breaks auto-update for every existing installation.

> ⚠ Do **not** commit any private key, PEM file, JWT secret, or `.env` file
> from this runbook into the repository. All values listed below live as
> **GitHub Actions repository secrets** under
> `Settings → Secrets and variables → Actions`.

---

## 1. Chromium CRX signing key (`CHROME_CRX_PRIVATE_KEY`)

The CRX private key is what makes every release CRX resolve to the *same*
extension ID. The matching public key is committed to `extension/manifest.json`
as the `key` field (it's the *public* half — safe to commit) and the release
workflow re-injects it from `CHROME_EXTENSION_KEY` at build time as a defensive
double-check.

### Generate (once)

```bash
# 2048-bit RSA, PKCS#8, PEM
openssl genrsa 2048 \
  | openssl pkcs8 -topk8 -nocrypt -outform PEM \
  > autodom.pem

# Derive the manifest `key` field (base64 SPKI of the public half):
openssl rsa -in autodom.pem -pubout -outform DER 2>/dev/null \
  | base64 -w0 > autodom.key.b64

# Derive the resulting Chrome extension ID (32-char a–p mangled SHA-256):
openssl rsa -in autodom.pem -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | head -c 16 \
  | xxd -p \
  | tr '0-9a-f' 'a-p'
```

Record three values:
1. **`autodom.pem`** — full PEM, multi-line. Store as the
   `CHROME_CRX_PRIVATE_KEY` Actions secret (paste contents including the
   `-----BEGIN PRIVATE KEY-----` header/footer).
2. **`autodom.key.b64`** — single-line base64. Store as the
   `CHROME_EXTENSION_KEY` Actions secret. The release workflow pipes this
   into the manifest's `key` field before zipping/CRX-packing.
3. **The 32-char extension ID.** Paste into the `<app appid="...">`
   attribute in the generated `updates.xml` and into the policy templates
   under `enterprise/`.

### Store

```bash
gh secret set CHROME_CRX_PRIVATE_KEY < autodom.pem
gh secret set CHROME_EXTENSION_KEY   < autodom.key.b64

# Then securely delete the local copies — only the secrets and the runbook
# should ever hold them.
#   • Linux:  shred -u autodom.pem autodom.key.b64
#   • macOS:  rm -P autodom.pem autodom.key.b64   (or `gshred -u …` if coreutils installed)
#   • Either: srm -m autodom.pem autodom.key.b64  (if `secure-delete` is installed)
rm -P autodom.pem autodom.key.b64 2>/dev/null || rm -f autodom.pem autodom.key.b64
```

### Rotation

Don't. A new key = a new extension ID = a forked, abandoned install base for
every existing user. If the key is leaked, the only safe path is:
1. Mint a new key (new extension ID).
2. Publish the new version under the new ID.
3. Ship a one-time uninstall + reinstall guide; old installs cannot be migrated.

---

## 2. GitHub Pages publishing token

The release workflow needs to push a regenerated `updates.xml` to the
`gh-pages` branch.

Easiest path (no extra secret):

1. `Settings → Pages → Source = Deploy from a branch → gh-pages / root`.
2. In `.github/workflows/release.yml`, grant the workflow:
   ```yaml
   permissions:
     contents: write
     pages: write
     id-token: write
   ```
   and use the built-in `${{ secrets.GITHUB_TOKEN }}`. No `GH_PAGES_TOKEN`
   secret needed.

If the repository owner enforces a stricter token scope, mint a fine-grained
PAT scoped to **this repo only** with `Contents: Read & Write` and store it
as `GH_PAGES_TOKEN`. The workflow will prefer it over `GITHUB_TOKEN` when
present.

---

## 3. Bootstrapping the public update URL

Before the first release runs, create the empty `gh-pages` branch with a
placeholder `updates.xml` so the URL resolves `200`:

```bash
git checkout --orphan gh-pages
git rm -rf .
cat > updates.xml <<'EOF'
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'/>
EOF
git add updates.xml
git commit -m "Bootstrap auto-update endpoint"
git push origin gh-pages
git checkout main
```

Then enable Pages on the `gh-pages` branch (Settings → Pages). Confirm:

- <https://eziocode.github.io/autodom-extension/updates.xml> → returns the
  empty `<gupdate>` document.

The first tagged release will overwrite the file with the real entry.

---

## 4. Sanity checklist before tagging the first release

- [ ] `CHROME_CRX_PRIVATE_KEY`, `CHROME_EXTENSION_KEY` set in repo secrets.
- [ ] `CHROME_EXTENSION_ID` set in repo variables.
- [ ] Recorded 32-char Chrome extension ID and pasted into
      `enterprise/*` policy templates.
- [ ] `gh-pages` branch exists with placeholder `updates.xml` and Pages is
      serving it.
- [ ] `extension/manifest.json` `update_url` resolves to the Pages URL.
- [ ] `extension/manifest.json` `key` field matches `CHROME_EXTENSION_KEY`.
- [ ] Release workflow has `permissions: contents: write, pages: write`.

Once all are checked, tag `vX.Y.Z` and push — the workflow will produce the
first signed CRX and publish the update manifest.
