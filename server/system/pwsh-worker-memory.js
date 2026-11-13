// The memory budget given to the PowerShell process that reads the sensors.

// The .NET default lets this small host grow far past the 20 MB it really uses.
// Hex, 16 MB: measured 180 to 125 MB private at the same CPU; 4 MB saves little more
// and costs 20% more CPU. Not on Microsoft's list of GC settings: if a runtime ignores
// it, nothing changes.
const PWSH_WORKER_GC_BUDGET = '1000000';

module.exports = { PWSH_WORKER_GC_BUDGET };
