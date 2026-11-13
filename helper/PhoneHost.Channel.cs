// Phone over Bluetooth: the Bluetooth socket the requests travel on.

using System.Text;
using System.Text.Json;
using Windows.ApplicationModel.Calls;
using Windows.Devices.Bluetooth.Rfcomm;
using Windows.Devices.Enumeration;
using Windows.Networking.Sockets;
using Windows.Storage.Streams;

namespace XenonHelper;

internal static partial class PhoneHost
{
    // ── Plumbing ────────────────────────────────────────────────────────────

    // The channel OBEX rides on. WinRT resolves the RFCOMM channel number out of
    // the peer's SDP record, which is the tedious part of talking to an
    // arbitrary Bluetooth service by hand.
    private sealed class SocketChannel : IByteChannel
    {
        private readonly StreamSocket _socket;
        private readonly DataReader _reader;
        private readonly DataWriter _writer;

        public SocketChannel(StreamSocket socket)
        {
            _socket = socket;
            _reader = new DataReader(socket.InputStream)
            {
                // Partial: hand back whatever has arrived. The default waits for
                // the FULL requested count, which deadlocks a reader that asks
                // for more than the next packet happens to carry.
                InputStreamOptions = InputStreamOptions.Partial,
            };
            _writer = new DataWriter(socket.OutputStream);
        }

        public async Task WriteAsync(byte[] data, CancellationToken ct = default)
        {
            _writer.WriteBytes(data);
            await _writer.StoreAsync().AsTask(ct);
            await _writer.FlushAsync().AsTask(ct);
        }

        public async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct = default)
        {
            if (_reader.UnconsumedBufferLength == 0)
            {
                var loaded = await _reader.LoadAsync((uint)count).AsTask(ct);
                if (loaded == 0) return 0;
            }
            var take = (int)Math.Min(_reader.UnconsumedBufferLength, (uint)count);
            var tmp = new byte[take];
            _reader.ReadBytes(tmp);
            Array.Copy(tmp, 0, buffer, offset, take);
            return take;
        }

        public void Dispose()
        {
            try { _reader.Dispose(); } catch { }
            try { _writer.Dispose(); } catch { }
            // The socket is owned by the caller's `using`, not by this wrapper.
        }
    }
}
