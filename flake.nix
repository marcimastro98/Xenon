{
  description = "Xenon: a dashboard for any spare screen";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      # Xenon's license is not a free one: this flake allows it for its own package only.
      pkgs = import nixpkgs {
        inherit system;
        config.allowUnfreePredicate = pkg: nixpkgs.lib.getName pkg == "xenon";
      };
      xenon = pkgs.callPackage ./nix/package.nix { };
    in
    {
      packages.${system} = {
        inherit xenon;
        default = xenon;
      };

      apps.${system}.default = {
        type = "app";
        program = nixpkgs.lib.getExe xenon;
        meta.description = xenon.meta.description;
      };

      overlays.default = final: _prev: {
        xenon = final.callPackage ./nix/package.nix { };
      };

      checks.${system} = {
        inherit xenon;
        engine = pkgs.testers.runNixOSTest (import ./nix/engine-test.nix { inherit xenon; });
      };
    };
}
