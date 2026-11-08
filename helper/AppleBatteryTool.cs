using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Enumeration;

namespace XenonHelper;

// AirPods and Beats give Windows no battery level, but they broadcast it to anyone nearby in
// Apple's own LE advert. One-shot mode: when such a device is connected to this PC, listens
// for a few seconds, passively, and prints one JSON line {"connected":[names],"adverts":
// [{"rssi":N,"hex":"..."}]}. Nothing is sent to any device, no address is printed, and
// without a connected device it does not listen at all. device-battery/apple-adverts.js
// decides what the bytes mean.
internal static class AppleBatteryTool
{
    private const ushort AppleCompanyId = 0x004C;
    private const byte NearbyPairingType = 0x07;
    private const int MinimumBytes = 8;
    private const int DefaultSeconds = 6;
    private const int MaximumSeconds = 15;
    private static readonly string[] NamesToListenFor = ["airpods", "beats"];

    public static async Task<int> RunAsync(string[] args)
    {
        var seconds = DefaultSeconds;
        if (args.Length > 1 && int.TryParse(args[1], out var parsed) && parsed > 0) seconds = Math.Min(parsed, MaximumSeconds);

        var connected = await ConnectedNamesAsync();
        var adverts = connected.Count > 0 ? await ListenAsync(seconds) : [];
        Console.WriteLine(JsonOut.Serialize(new Dictionary<string, object?> { ["connected"] = connected, ["adverts"] = adverts }));
        return 0;
    }

    private static async Task<List<object?>> ConnectedNamesAsync()
    {
        var selector = BluetoothDevice.GetDeviceSelectorFromConnectionStatus(BluetoothConnectionStatus.Connected);
        var devices = await DeviceInformation.FindAllAsync(selector);
        return devices
            .Select(device => device.Name)
            .Where(name => NamesToListenFor.Any(known => name.Contains(known, StringComparison.OrdinalIgnoreCase)))
            .Distinct()
            .Cast<object?>()
            .ToList();
    }

    private static async Task<List<object?>> ListenAsync(int seconds)
    {
        var strongest = new Dictionary<string, int>();
        var watcher = new BluetoothLEAdvertisementWatcher { ScanningMode = BluetoothLEScanningMode.Passive };
        watcher.Received += (_, e) =>
        {
            foreach (var data in e.Advertisement.ManufacturerData)
            {
                if (data.CompanyId != AppleCompanyId) continue;
                var bytes = data.Data.ToArray();
                if (bytes.Length < MinimumBytes || bytes[0] != NearbyPairingType) continue;
                var hex = Convert.ToHexString(bytes).ToLowerInvariant();
                lock (strongest)
                {
                    if (!strongest.TryGetValue(hex, out var rssi) || e.RawSignalStrengthInDBm > rssi) strongest[hex] = e.RawSignalStrengthInDBm;
                }
            }
        };
        watcher.Start();
        await Task.Delay(TimeSpan.FromSeconds(seconds));
        watcher.Stop();
        lock (strongest)
        {
            return strongest
                .Select(entry => (object?)new Dictionary<string, object?> { ["rssi"] = entry.Value, ["hex"] = entry.Key })
                .ToList();
        }
    }
}
