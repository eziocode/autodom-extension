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
extension ID. The matching public key is embedded into `manifest.json` as the
`key` field at packaging time (the release workflow injects it — we do **not**
commit it to source).

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

## 2. Mozilla AMO signing credentials (`AMO_JWT_ISSUER` / `AMO_JWT_SECRET`)

Mozilla signs self-hosted ("unlisted") XPIs without listing them on
addons.mozilla.org. Release Firefox refuses unsigned add-ons, so this step is
mandatory before any non-developer-edition Firefox can install AutoDOM.

### Mint

1. Sign in at <https://addons.mozilla.org> with the maintainer account
   (the account whose email matches `browser_specific_settings.gecko.id` is
   recommended but not required).
2. Visit <https://addons.mozilla.org/developers/addon/api/key/>.
3. Click **Generate new credentials**.
4. Copy:
   - **JWT issuer** → `AMO_JWT_ISSUER` Actions secret.
   - **JWT secret** → `AMO_JWT_SECRET` Actions secret.

```bash
gh secret set AMO_JWT_ISSUER --body "user:1234567:567"
gh secret set AMO_JWT_SECRET --body "abc123…"
```

### First submission

Mozilla treats the very first upload of `aswin2kumarforme@gmail.com` (the
gecko ID in `manifest.firefox.json`) as the registration of that add-on slug.
After that, every release pipeline run will sign successive versions
automatically.

### Rotation

Safe — issuer/secret changes do not change the add-on's identity. Generate a
new key pair on AMO, replace the two secrets, and revoke the old pair.

---

## 3. GitHub Pages publishing token

The release workflow needs to push regenerated `updates.xml` and
`updates.json` to the `gh-pages` branch.

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

## 4. Bootstrapping the public update URLs

Before the first release runs, create the empty `gh-pages` branch with a
placeholder `updates.xml` and `updates.json` so the URLs resolve `200`:

```bash
git checkout --orphan gh-pages
git rm -rf .
cat > updates.xml <<'EOF'
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'/>
EOF
cat > updates.json <<'EOF'
{ "addons": {} }
EOF
git add updates.xml updates.json
git commit -m "Bootstrap auto-update endpoints"
git push origin gh-pages
git checkout main
```

Then enable Pages on the `gh-pages` branch (Settings → Pages). Confirm:

- <https://eziocode.github.io/autodom-extension/updates.xml> → returns the
  empty `<gupdate>` document.
- <https://eziocode.github.io/autodom-extension/updates.json> → returns
  `{ "addons": {} }`.

The first tagged release will overwrite both files with real entries.

---

## 5. Sanity checklist before tagging the first release

- [ ] `CHROME_CRX_PRIVATE_KEY`, `CHROME_EXTENSION_KEY`, `AMO_JWT_ISSUER`,
      `AMO_JWT_SECRET` all set in repo secrets.
- [ ] Recorded 32-char Chrome extension ID and pasted into
      `enterprise/*` policy templates and the `updates.xml` template.
- [ ] `gh-pages` branch exists with placeholder `updates.xml` /
      `updates.json` and Pages is serving them.
- [ ] `extension/manifest.json` `update_url` resolves to the Pages URL.
- [ ] `extension/manifest.firefox.json` `gecko.update_url` resolves to the
      Pages URL.
- [ ] Release workflow has `permissions: contents: write, pages: write`.

Once all six are checked, tag `v2.2.0` (or next) and push — the workflow
will produce the first signed CRX + XPI and publish the update manifests.
