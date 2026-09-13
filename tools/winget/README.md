# Publishing Xenon on winget

Why: `winget install xenon` is one line a person can paste from a Reddit
comment, it is what the tech-literate half of the audience already uses, and a
package that lives in Microsoft's own repository is a trust signal the unsigned
`.exe` does not carry on its own.

The manifests here are the three files winget needs, filled in for the version
they are named after. Nothing in this folder is read by the app or by CI; it is
the working copy for the pull request to `microsoft/winget-pkgs`.

## First submission (once)

1. Install the tool: `winget install Microsoft.WingetCreate`.
2. Validate locally: `winget validate --manifest manifests/m/marcimastro98/Xenon/4.11.8`
   and, on a clean machine or VM, `winget install --manifest manifests/m/marcimastro98/Xenon/4.11.8`.
   The install must finish without a prompt when run with `--silent`.
3. Submit: `wingetcreate submit --token <github PAT with public_repo> manifests/m/marcimastro98/Xenon/4.11.8`.
   This forks `microsoft/winget-pkgs` under your account and opens the pull
   request. A bot validates it; a human from Microsoft merges it, usually
   within a few days. Answer their comments on the PR itself.

## Every release after that

`wingetcreate update marcimastro98.Xenon --version <x.y.z> --urls https://github.com/marcimastro98/Xenon/releases/download/v<x.y.z>/Xenon-Setup-x64.exe --submit --token <PAT>`

It downloads the installer, computes the hash and opens the PR. Two minutes.
Once the first version is merged, this line belongs in `release.yml` as a step
that runs after the assets are uploaded, with the PAT as a repository secret.

## Things that matter

- The URL is the **versioned** one under `releases/download/v<x.y.z>/`, never
  `releases/latest/download/`. winget pins a hash to a URL; a moving URL breaks
  the moment the next release ships.
- The hash is the SHA-256 of `Xenon-Setup-x64.exe` in uppercase. The value in
  `4.11.8` was taken from the `SHA256SUMS` asset of that release.
- `Scope: user` because the NSIS config installs per-user (`installMode:
  currentUser`). If that ever changes to `perMachine`, change it here too or
  the validator will refuse the manifest.
- The installer is not code-signed yet. winget does not require a signature,
  but the reviewers do run the file through Defender; a false positive on the
  current build delays the merge until it clears. Submit right after a release
  that scans clean, and re-run the scan on the PR if it is flagged.
- The Microsoft Store is a separate channel with a separate account
  (one-time developer registration) and a packaged (MSIX) build. Worth doing
  after the certificate arrives; winget first, it is free and needs no repackaging.
