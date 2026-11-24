# On a real NixOS (no /lib64 loader, read-only store), as an ordinary user: the app
# places its engine in a scratch folder and the engine answers. From 5.3.0 the
# engine's Node is a link into the package, never a copy.
{ xenon }:
{ lib, ... }:
{
  name = "xenon-engine";

  nodes.machine = {
    users.users.alice = {
      isNormalUser = true;
      uid = 1000;
    };
    environment.systemPackages = [ xenon ];
  };

  testScript = ''
    machine.wait_for_unit("multi-user.target")
    out = machine.succeed(
        "su - alice -c 'xenon-native --install-engine-selftest "
        "${xenon}/lib/Xenon/engine /home/alice/xenon-root 39124 2>&1'"
    )
    print(out)
    assert "answered on 39124" in out, out
    ${lib.optionalString (lib.versionAtLeast xenon.version "5.3.0") ''
      machine.succeed("test -L /home/alice/xenon-root/node-runtime")
      machine.succeed("readlink -f /home/alice/xenon-root/node-runtime | grep -q '^/nix/store/'")
    ''}
  '';
}
