# Xenon for Nix: the signed .deb of a GitHub release, made to run from the Nix store.
#
# The app copies its engine into ~/.local/share/Xenon on first start and the engine
# updates itself there, as on every other Linux install. XENON_MANAGED_BY tells the
# app that Nix owns the program itself: it never tries to replace it, links the
# engine's Node from this package instead of copying it (a copy would point at
# libraries a garbage collection deletes), and starts at login as `xenon-native`.
# The version and checksum come from source.json (tools/nix/bump.mjs writes it).
{
  lib,
  stdenv,
  fetchurl,
  dpkg,
  autoPatchelfHook,
  wrapGAppsHook3,
  webkitgtk_4_1,
  gtk3,
  glib,
  glib-networking,
  libsoup_3,
  cairo,
  gdk-pixbuf,
  dbus,
  libx11,
  libayatana-appindicator,
  gtk-layer-shell,
  librsvg,
  gst_all_1,
}:

let
  source = lib.importJSON ./source.json;
in
stdenv.mkDerivation {
  pname = "xenon";
  inherit (source) version;

  src = fetchurl {
    inherit (source) url sha256;
  };

  nativeBuildInputs = [
    dpkg
    autoPatchelfHook
    wrapGAppsHook3
  ];

  # What the app and the engine's Node link against, plus what WebKitGTK needs at
  # run time: TLS (glib-networking), icons (librsvg) and sound (GStreamer).
  buildInputs = [
    webkitgtk_4_1
    gtk3
    glib
    glib-networking
    libsoup_3
    cairo
    gdk-pixbuf
    dbus
    libx11
    librsvg
    stdenv.cc.cc.lib
    gst_all_1.gstreamer
    gst_all_1.gst-plugins-base
    gst_all_1.gst-plugins-good
  ];

  unpackPhase = ''
    runHook preUnpack
    dpkg-deb --fsys-tarfile "$src" | tar -x --no-same-owner --no-same-permissions
    runHook postUnpack
  '';

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -r usr/bin usr/lib usr/share "$out/"
    chmod +x "$out/bin/xenon-native" "$out/lib/Xenon/engine/node-runtime/bin/node"
    substituteInPlace "$out/share/applications/Xenon.desktop" \
      --replace-quiet "Exec=/usr/bin/xenon-native" "Exec=xenon-native"
    runHook postInstall
  '';

  # The tray icon and the Wayland layer surfaces are loaded on demand, not linked.
  preFixup = ''
    gappsWrapperArgs+=(
      --set XENON_MANAGED_BY nix
      --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ libayatana-appindicator gtk-layer-shell ]}
    )
  '';

  meta = {
    description = "Dashboard for any spare screen: second monitor, touchscreen, tablet or phone";
    homepage = "https://xenon-app.com";
    changelog = "https://github.com/marcimastro98/Xenon/blob/main/CHANGELOG.md";
    license = {
      fullName = "Xenon License (non-commercial)";
      url = "https://github.com/marcimastro98/Xenon/blob/main/LICENSE";
      free = false;
      redistributable = false;
    };
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = [ "x86_64-linux" ];
    mainProgram = "xenon-native";
  };
}
