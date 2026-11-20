#!/usr/bin/env bash
# update-aur.sh <version>: points the AUR package kuubl-bin at a released version and pushes it.
# Run after release.ps1 (it publishes SHA256SUMS). Needs an AUR account whose SSH keys include
# ~/.ssh/aur_kuubl.pub (aur.archlinux.org -> My Account -> SSH Public Key).
set -euo pipefail
v="$1"
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$here/kuubl-bin"
file="kuubl-client-$v-1-x86_64.pkg.tar.zst"
sha=$(curl -sf https://ertenix.net/kuubl/SHA256SUMS | awk -v f="$file" '$2==f || $2=="*"f {print $1}')
[ -n "$sha" ] || { echo "no checksum for $file in SHA256SUMS"; exit 1; }

sed -i -e "s/^pkgver=.*/pkgver=$v/" -e "s/^pkgrel=.*/pkgrel=1/" -e "s/^sha256sums=.*/sha256sums=('$sha')/" "$pkg/PKGBUILD"

# .SRCINFO from the PKGBUILD (makepkg --printsrcinfo isn't available on Windows).
# shortcut: only the fields this PKGBUILD uses; use makepkg --printsrcinfo if the PKGBUILD grows.
(
  # shellcheck disable=SC1091
  source "$pkg/PKGBUILD"
  {
    echo "pkgbase = $pkgname"
    printf '\tpkgdesc = %s\n\tpkgver = %s\n\tpkgrel = %s\n\turl = %s\n' "$pkgdesc" "$pkgver" "$pkgrel" "$url"
    for a in "${arch[@]}"; do printf '\tarch = %s\n' "$a"; done
    for l in "${license[@]}"; do printf '\tlicense = %s\n' "$l"; done
    for d in "${depends[@]}"; do printf '\tdepends = %s\n' "$d"; done
    for d in "${optdepends[@]}"; do printf '\toptdepends = %s\n' "$d"; done
    for p in "${provides[@]}"; do printf '\tprovides = %s\n' "$p"; done
    for c in "${conflicts[@]}"; do printf '\tconflicts = %s\n' "$c"; done
    for o in "${options[@]}"; do printf '\toptions = %s\n' "$o"; done
    for s in "${source[@]}"; do printf '\tsource = %s\n' "$s"; done
    for n in "${noextract[@]}"; do printf '\tnoextract = %s\n' "$n"; done
    for s in "${sha256sums[@]}"; do printf '\tsha256sums = %s\n' "$s"; done
    printf '\npkgname = %s\n' "$pkgname"
  } > "$pkg/.SRCINFO"
)

tmp="$(mktemp -d)"
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/aur_kuubl -o IdentitiesOnly=yes"
git clone -q ssh://aur@aur.archlinux.org/kuubl-bin.git "$tmp/aur"
cp "$pkg/PKGBUILD" "$pkg/.SRCINFO" "$tmp/aur/"
cd "$tmp/aur"
git add PKGBUILD .SRCINFO
git -c user.name="maxem" -c user.email="maxernytb@gmail.com" commit -qm "Update to $v" || echo "nothing to commit"
git push -q origin HEAD:master
echo "kuubl-bin $v pushed to the AUR"
rm -rf "$tmp"
