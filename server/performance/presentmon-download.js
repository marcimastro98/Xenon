// Where the frame-rate reader PresentMon is downloaded from, and the checksum the file must
// have.

// PresentMon 1.10.0, the last classic single-binary CLI fpsmon.js parses: the
// exact asset and the SHA-256 of the reviewed bytes (install.ps1 carries the
// same pair). Bump both together.
const PRESENTMON_URL = 'https://github.com/GameTechDev/PresentMon/releases/download/v1.10.0/PresentMon-1.10.0-x64.exe';
const PRESENTMON_SHA256 = 'e57a2f8ee1de1ef1a5516d875f1b115e881943cd729fe9c5a2f88b1dc79a8a3b';

module.exports = { PRESENTMON_URL, PRESENTMON_SHA256 };
