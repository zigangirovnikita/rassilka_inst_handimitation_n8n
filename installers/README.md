# Installers

`install-mac.command` builds the macOS app from this repository and installs it into `/Applications`.

The packaged DMG is generated locally by:

```bash
node scripts/package-mac-dmg.mjs
```

Generated `.dmg` files are intentionally ignored by git. Upload them to GitHub Releases instead of committing them to repository history.
