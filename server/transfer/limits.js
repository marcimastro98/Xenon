// Limits of file transfer from a phone: the free disk space that must remain, and the largest
// picture shown as a preview.

// Never let a transfer be the thing that fills the system drive: refuse an
// upload that would leave less than this free, before it starts.
const TRANSFER_DISK_HEADROOM = 1024 * 1024 * 1024;
// A list preview is read whole into memory, so it is only offered for files
// small enough that doing so is free. Bigger images show an extension chip.
const TRANSFER_THUMB_MAX = 12 * 1024 * 1024;

module.exports = { TRANSFER_DISK_HEADROOM, TRANSFER_THUMB_MAX };
