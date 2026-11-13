// The example widgets that ship with Xenon and can be installed by name.

// Bundled reference widgets installable via POST /sdk/widgets/example — id ->
// folder name under server/sdk-example/. Fixed allowlist so the requested id
// is a lookup key, never interpolated into a filesystem path.
const EXAMPLE_WIDGETS = {
  'hello-xenon': 'hello-xenon',
  'teleprompter': 'teleprompter',
  'github-stars': 'github-stars',
  'ha-room': 'ha-room',
};

module.exports = { EXAMPLE_WIDGETS };
