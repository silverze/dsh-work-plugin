// DSH Work — Windows screen reader.
//
// The Windows counterpart of screen-ocr.swift: same command line, same JSON
// shapes, same normalised line coordinates, so the TypeScript parser is shared.
//
//   screen-ocr --list          visible windows as JSON
//   screen-ocr --frontmost     foreground application as JSON
//   screen-ocr --feishu        pick the Feishu window, capture + OCR it
//   screen-ocr <pid> [window]  capture one window and OCR it
//
// Built on first use with the .NET Framework `csc.exe` that ships with Windows
// (the same model as `swiftc` on macOS), so there is no PowerShell startup cost:
// a read is ~1 s instead of ~3.5 s. `PrintWindow(PW_RENDERFULLCONTENT)` renders
// the window even when Feishu is behind DSH, and `Windows.Media.Ocr` reads it;
// the bitmap is scaled 2x first because Windows' OCR model is much better on
// larger UI text. OCR runs on an in-memory PNG so nothing touches the disk.
//
// The bitmap and OCR text never leave the machine: this program only prints the
// recognised lines to stdout.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

internal static class Program
{
    // ---- Win32 interop -----------------------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private sealed class WindowInfo
    {
        public IntPtr Handle;
        public int Pid;
        public string Title = string.Empty;
        public string Owner = string.Empty;
        public bool Minimized;
        public int X;
        public int Y;
        public int Width;
        public int Height;

        public int Area { get { return Width * Height; } }
    }

    private static string ProcessName(uint pid)
    {
        IntPtr handle = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (handle == IntPtr.Zero) return string.Empty;
        try
        {
            uint size = 1024;
            var buffer = new StringBuilder((int)size);
            if (!QueryFullProcessImageNameW(handle, 0, buffer, ref size)) return string.Empty;
            string full = buffer.ToString();
            int slash = full.LastIndexOfAny(new[] { '\\', '/' });
            string name = slash >= 0 ? full.Substring(slash + 1) : full;
            return name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                ? name.Substring(0, name.Length - 4)
                : name;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    private static string WindowTitle(IntPtr hwnd)
    {
        int length = GetWindowTextLengthW(hwnd);
        if (length <= 0) return string.Empty;
        var buffer = new StringBuilder(length + 2);
        GetWindowTextW(hwnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    private static bool IsCloaked(IntPtr hwnd)
    {
        int cloaked;
        // DWMWA_CLOAKED: hidden UWP frames and suspended windows report 1..4.
        if (DwmGetWindowAttribute(hwnd, 14, out cloaked, sizeof(int)) != 0) return false;
        return cloaked != 0;
    }

    private static List<IntPtr> TopLevelWindows()
    {
        var found = new List<IntPtr>();
        EnumWindows((hwnd, _) => { found.Add(hwnd); return true; }, IntPtr.Zero);
        return found;
    }

    private static WindowInfo Inspect(IntPtr hwnd)
    {
        if (!IsWindowVisible(hwnd)) return null;
        if (IsCloaked(hwnd)) return null;
        RECT rect;
        if (!GetWindowRect(hwnd, out rect)) return null;
        int width = rect.Right - rect.Left;
        int height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0) return null;
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        return new WindowInfo
        {
            Handle = hwnd,
            Pid = (int)pid,
            Title = WindowTitle(hwnd),
            Owner = ProcessName(pid),
            Minimized = IsIconic(hwnd),
            X = rect.Left,
            Y = rect.Top,
            Width = width,
            Height = height,
        };
    }

    private static bool Better(WindowInfo candidate, WindowInfo current)
    {
        if (current == null) return true;
        if (current.Minimized && !candidate.Minimized) return true;
        if (current.Minimized == candidate.Minimized && candidate.Area > current.Area) return true;
        return false;
    }

    // ---- Window selection --------------------------------------------------

    private static List<WindowInfo> VisibleWindows(bool requireTitle, int minWidth, int minHeight)
    {
        var rows = new List<WindowInfo>();
        foreach (IntPtr hwnd in TopLevelWindows())
        {
            WindowInfo info = Inspect(hwnd);
            if (info == null) continue;
            if (requireTitle && info.Title.Length == 0) continue;
            if (info.Width < minWidth || info.Height < minHeight) continue;
            rows.Add(info);
        }
        return rows;
    }

    /// <summary>Largest titled window of one process; the explicit handle wins.</summary>
    private static WindowInfo ChooseWindow(int pid, long explicitHandle, bool requireTitle)
    {
        WindowInfo best = null;
        foreach (IntPtr hwnd in TopLevelWindows())
        {
            if (explicitHandle != 0 && hwnd.ToInt64() != explicitHandle) continue;
            WindowInfo info = Inspect(hwnd);
            if (info == null) continue;
            if (info.Pid != pid) continue;
            if (requireTitle && info.Title.Length == 0) continue;
            if (Better(info, best)) best = info;
        }
        return best;
    }

    /// <summary>
    /// Windows runs a dozen helper processes all called Feishu.exe, so a pid
    /// list cannot tell which one owns the chat window. The window is the only
    /// reliable handle, and picking it directly saves a process launch.
    /// </summary>
    private static WindowInfo ChooseFeishuWindow()
    {
        WindowInfo best = null;
        foreach (IntPtr hwnd in TopLevelWindows())
        {
            WindowInfo info = Inspect(hwnd);
            if (info == null) continue;
            if (info.Title.Length == 0) continue;
            if (info.Width < 400 || info.Height < 300) continue;
            if (!IsFeishuOwner(info.Owner)) continue;
            if (Better(info, best)) best = info;
        }
        return best;
    }

    private static bool IsFeishuOwner(string owner)
    {
        if (string.IsNullOrEmpty(owner)) return false;
        switch (owner.ToLowerInvariant())
        {
            case "feishu":
            case "lark":
            case "larkinternational":
            case "miworksaas":
            case "saxmsa667":
                return true;
            default:
                return false;
        }
    }

    // ---- Capture + OCR -----------------------------------------------------

    private static Bitmap Capture(WindowInfo info, double scale)
    {
        var source = new Bitmap(info.Width, info.Height);
        bool printed;
        using (Graphics graphics = Graphics.FromImage(source))
        {
            IntPtr hdc = graphics.GetHdc();
            printed = PrintWindow(info.Handle, hdc, 2 /* PW_RENDERFULLCONTENT */);
            graphics.ReleaseHdc(hdc);
        }

        // A window that refuses PrintWindow comes back as one flat colour; copying
        // the on-screen rectangle is the only way to read it, and needs it visible.
        int sampled = 0;
        int colored = 0;
        for (int y = 8; y < info.Height; y += 37)
        {
            for (int x = 8; x < info.Width; x += 37)
            {
                Color pixel = source.GetPixel(x, y);
                sampled++;
                if (pixel.R + pixel.G + pixel.B > 30) colored++;
            }
        }
        if (!printed || colored <= sampled / 50)
        {
            source.Dispose();
            var screen = new Bitmap(info.Width, info.Height);
            using (Graphics graphics = Graphics.FromImage(screen))
            {
                graphics.CopyFromScreen(info.X, info.Y, 0, 0, new Size(info.Width, info.Height));
            }
            return screen;
        }

        if (scale <= 1.0) return source;
        var scaled = new Bitmap((int)(info.Width * scale), (int)(info.Height * scale));
        using (var graphics = Graphics.FromImage(scaled))
        {
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.DrawImage(source, 0, 0, scaled.Width, scaled.Height);
        }
        source.Dispose();
        return scaled;
    }

    private static async Task<OcrResult> OcrAsync(Bitmap bitmap)
    {
        byte[] png;
        using (var memory = new MemoryStream())
        {
            bitmap.Save(memory, ImageFormat.Png);
            png = memory.ToArray();
        }

        // In-memory stream: the same decode path as a file, without touching disk.
        var stream = new InMemoryRandomAccessStream();
        await stream.WriteAsync(png.AsBuffer());
        stream.Seek(0);
        BitmapDecoder decoder = await BitmapDecoder.CreateAsync(stream);
        SoftwareBitmap software = await decoder.GetSoftwareBitmapAsync();
        OcrEngine engine = OcrEngine.TryCreateFromUserProfileLanguages() ?? AnyEngine();
        if (engine == null) throw new InvalidOperationException("no OCR language pack is installed");
        return await engine.RecognizeAsync(software);
    }

    private static OcrEngine AnyEngine()
    {
        foreach (var language in OcrEngine.AvailableRecognizerLanguages)
        {
            OcrEngine engine = OcrEngine.TryCreateFromLanguage(language);
            if (engine != null) return engine;
        }
        return null;
    }

    private static Captured CaptureWithOcr(WindowInfo info)
    {
        if (info.Minimized) throw new InvalidOperationException("the window is minimized");
        const double scale = 2.0;
        using (Bitmap bitmap = Capture(info, scale))
        {
            OcrResult result = OcrAsync(bitmap).GetAwaiter().GetResult();
            var lines = new List<Line>();
            foreach (OcrLine line in result.Lines)
            {
                if (line.Words.Count == 0) continue;
                double x1 = double.MaxValue, y1 = double.MaxValue;
                double x2 = double.MinValue, y2 = double.MinValue;
                foreach (OcrWord word in line.Words)
                {
                    x1 = Math.Min(x1, word.BoundingRect.X);
                    y1 = Math.Min(y1, word.BoundingRect.Y);
                    x2 = Math.Max(x2, word.BoundingRect.X + word.BoundingRect.Width);
                    y2 = Math.Max(y2, word.BoundingRect.Y + word.BoundingRect.Height);
                }
                lines.Add(new Line
                {
                    Text = line.Text,
                    X = x1 / bitmap.Width,
                    Y = y1 / bitmap.Height,
                    W = (x2 - x1) / bitmap.Width,
                    H = (y2 - y1) / bitmap.Height,
                });
            }
            lines.Sort((a, b) => a.Y == b.Y ? a.X.CompareTo(b.X) : a.Y.CompareTo(b.Y));
            return new Captured { Info = info, Lines = lines };
        }
    }

    private sealed class Line
    {
        public string Text;
        public double X, Y, W, H;
    }

    private sealed class Captured
    {
        public WindowInfo Info;
        public List<Line> Lines;
    }

    // ---- JSON --------------------------------------------------------------

    private static string Quote(string value)
    {
        var builder = new StringBuilder(value.Length + 2);
        builder.Append('"');
        foreach (char c in value)
        {
            switch (c)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (c < ' ') builder.Append("\\u").Append(((int)c).ToString("x4"));
                    else builder.Append(c);
                    break;
            }
        }
        builder.Append('"');
        return builder.ToString();
    }

    private static string Number(double value)
    {
        return Math.Round(value, 4).ToString("0.####", CultureInfo.InvariantCulture);
    }

    private static void Emit(string json)
    {
        Console.Out.Write(json);
        Console.Out.Flush();
    }

    // ---- UI Automation -----------------------------------------------------
    //
    // Feishu is Chromium, and Chromium exposes its web content to UI Automation
    // once a UIA client connects to the frame's HWND. The text is exact, so it
    // is always preferred over OCR; the OCR path stays for builds whose
    // accessibility tree is disabled or empty.

    private sealed class UiaItem
    {
        public string Text = string.Empty;
        public int X, Y, W, H;
    }

    private static void WalkElement(
        AutomationElement element,
        int depth,
        int windowX,
        int windowY,
        List<UiaItem> items,
        ref int budget)
    {
        if (depth > 30 || budget <= 0) return;
        budget -= 1;
        try
        {
            AutomationElement.AutomationElementInformation current = element.Current;
            string name = (current.Name ?? string.Empty).Trim();
            // Only text nodes carry conversation content; container names ("Chrome
            // Legacy Window") and image alt texts ("medalImage") would otherwise
            // be parsed as the chat title or as a message.
            bool isText = current.ControlType == ControlType.Text;
            if (isText && name.Length > 0)
            {
                System.Windows.Rect rect = current.BoundingRectangle;
                if (rect.Width >= 1 && rect.Height >= 1)
                {
                    items.Add(new UiaItem
                    {
                        Text = name.Replace("\r", " ").Replace("\n", " "),
                        X = (int)rect.X - windowX,
                        Y = (int)rect.Y - windowY,
                        W = (int)rect.Width,
                        H = (int)rect.Height,
                    });
                }
            }
        }
        catch
        {
            return;
        }

        TreeWalker walker = TreeWalker.ControlViewWalker;
        AutomationElement child;
        try { child = walker.GetFirstChild(element); }
        catch { return; }
        while (child != null)
        {
            WalkElement(child, depth + 1, windowX, windowY, items, ref budget);
            if (budget <= 0) return;
            try { child = walker.GetNextSibling(child); }
            catch { return; }
        }
    }

    private static List<UiaItem> CollectUiaItems(WindowInfo info)
    {
        var renderers = new List<IntPtr>();
        // Chromium renders each web view into its own renderer child window.
        EnumChildWindows(info.Handle, (hwnd, _) =>
        {
            if (WindowClass(hwnd) == "Chrome_RenderWidgetHostHWND") renderers.Add(hwnd);
            return true;
        }, IntPtr.Zero);

        var items = new List<UiaItem>();
        int budget = 8000;
        for (int pass = 0; pass < 2 && items.Count < 20; pass += 1)
        {
            foreach (IntPtr renderer in renderers)
            {
                if (budget <= 0) break;
                try
                {
                    AutomationElement root = AutomationElement.FromHandle(renderer);
                    WalkElement(root, 0, info.X, info.Y, items, ref budget);
                }
                catch
                {
                    // A frame that refuses UIA is skipped; the others still work.
                }
            }
            if (items.Count > 0) break;
            // The first connection is what enables accessibility in Chromium.
            Thread.Sleep(250);
        }
        return items;
    }

    /// <summary>Visible UIA text as parser lines, normalised to the window box.</summary>
    private static List<Line> ReadUia(WindowInfo info)
    {
        var items = new List<UiaItem>();
        foreach (UiaItem item in CollectUiaItems(info))
        {
            if (item.X < -4 || item.Y < -4) continue;
            if (item.X + item.W > info.Width + 4 || item.Y + item.H > info.Height + 4) continue;
            // Reaction tooltips ("[赞]") are 1px tall ghosts of the emoji badges.
            if (item.H < 4) continue;
            items.Add(item);
        }
        items.Sort((a, b) =>
        {
            int byY = a.Y.CompareTo(b.Y);
            return byY != 0 ? byY : a.X.CompareTo(b.X);
        });

        // Feishu splits one message into several inline spans ("泽哥，你说的" +
        // "token" + "是找哪个同事来着"), so neighbouring texts on the same row are
        // joined back into one line.
        var lines = new List<Line>();
        foreach (UiaItem item in items)
        {
            Line previous = lines.Count > 0 ? lines[lines.Count - 1] : null;
            if (previous != null)
            {
                double previousBottom = (previous.Y + previous.H) * info.Height;
                bool sameRow = Math.Abs(item.Y - previous.Y * info.Height) <= Math.Max(item.H, previous.H * info.Height) * 0.6;
                double gap = item.X - (previous.X + previous.W) * info.Width;
                if (sameRow && gap >= -2 && gap <= 10 && previousBottom > item.Y - 2)
                {
                    previous.Text = JoinInline(previous.Text, item.Text);
                    double right = Math.Max((previous.X + previous.W) * info.Width, item.X + item.W);
                    previous.X = Math.Min(previous.X * info.Width, item.X) / info.Width;
                    previous.W = right / info.Width - previous.X;
                    previous.H = Math.Max(previous.H, (double)item.H / info.Height);
                    continue;
                }
            }
            lines.Add(new Line
            {
                Text = item.Text,
                X = (double)item.X / info.Width,
                Y = (double)item.Y / info.Height,
                W = (double)item.W / info.Width,
                H = (double)item.H / info.Height,
            });
        }
        return lines;
    }

    /// <summary>Join two inline spans: a space only where two Latin words meet.</summary>
    private static string JoinInline(string left, string right)
    {
        if (left.Length == 0) return right;
        if (right.Length == 0) return left;
        char before = left[left.Length - 1];
        char after = right[0];
        bool latinBoundary = ((before >= 'a' && before <= 'z') || (before >= 'A' && before <= 'Z') || (before >= '0' && before <= '9'))
            && ((after >= 'a' && after <= 'z') || (after >= 'A' && after <= 'Z') || (after >= '0' && after <= '9'));
        return latinBoundary ? left + " " + right : left + right;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);

    private static string WindowClass(IntPtr hwnd)
    {
        var text = new StringBuilder(256);
        GetClassNameW(hwnd, text, text.Capacity);
        return text.ToString();
    }

    private static void EmitCapture(Captured captured, bool feishu, string source)
    {
        WindowInfo info = captured.Info;
        var builder = new StringBuilder();
        builder.Append('{');
        builder.Append("\"pid\":").Append(info.Pid).Append(',');
        builder.Append("\"windowNumber\":").Append(info.Handle.ToInt64()).Append(',');
        builder.Append("\"onScreen\":").Append(info.Minimized ? "false" : "true").Append(',');
        builder.Append("\"bounds\":{")
            .Append("\"x\":").Append(info.X).Append(',')
            .Append("\"y\":").Append(info.Y).Append(',')
            .Append("\"width\":").Append(info.Width).Append(',')
            .Append("\"height\":").Append(info.Height).Append("},");
        builder.Append("\"imageWidth\":").Append(info.Width).Append(',');
        builder.Append("\"imageHeight\":").Append(info.Height).Append(',');
        builder.Append("\"source\":").Append(Quote(source)).Append(',');
        if (feishu)
        {
            bool front = GetForegroundWindow() == info.Handle;
            builder.Append("\"frontmost\":").Append(front ? "true" : "false").Append(',');
        }
        builder.Append("\"lines\":[");
        for (int index = 0; index < captured.Lines.Count; index++)
        {
            Line line = captured.Lines[index];
            if (index > 0) builder.Append(',');
            builder.Append("{\"text\":").Append(Quote(line.Text))
                .Append(",\"x\":").Append(Number(line.X))
                .Append(",\"y\":").Append(Number(line.Y))
                .Append(",\"w\":").Append(Number(line.W))
                .Append(",\"h\":").Append(Number(line.H))
                .Append('}');
        }
        builder.Append("]}");
        Emit(builder.ToString());
    }

    // ---- Entry point -------------------------------------------------------

    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length == 0)
            {
                Console.Error.Write("usage: screen-ocr --list | --frontmost | --feishu | <pid> [window]");
                return 2;
            }

            switch (args[0])
            {
                case "--list":
                {
                    var builder = new StringBuilder();
                    builder.Append('[');
                    List<WindowInfo> windows = VisibleWindows(true, 200, 150);
                    windows.Sort((a, b) => b.Area.CompareTo(a.Area));
                    for (int index = 0; index < windows.Count; index++)
                    {
                        WindowInfo info = windows[index];
                        if (index > 0) builder.Append(',');
                        builder.Append('{')
                            .Append("\"pid\":").Append(info.Pid).Append(',')
                            .Append("\"windowNumber\":").Append(info.Handle.ToInt64()).Append(',')
                            .Append("\"owner\":").Append(Quote(info.Owner)).Append(',')
                            .Append("\"title\":").Append(Quote(info.Title)).Append(',')
                            .Append("\"x\":").Append(info.X).Append(',')
                            .Append("\"y\":").Append(info.Y).Append(',')
                            .Append("\"width\":").Append(info.Width).Append(',')
                            .Append("\"height\":").Append(info.Height).Append(',')
                            .Append("\"onScreen\":").Append(info.Minimized ? "false" : "true")
                            .Append('}');
                    }
                    builder.Append(']');
                    Emit(builder.ToString());
                    return 0;
                }

                case "--frontmost":
                {
                    IntPtr hwnd = GetForegroundWindow();
                    uint pid = 0;
                    if (hwnd != IntPtr.Zero) GetWindowThreadProcessId(hwnd, out pid);
                    string name = pid != 0 ? ProcessName(pid) : string.Empty;
                    Emit("{\"pid\":" + pid + ",\"name\":" + Quote(name) + ",\"bundleId\":\"\"}");
                    return 0;
                }

                case "--feishu":
                {
                    WindowInfo info = ChooseFeishuWindow();
                    if (info == null)
                    {
                        Console.Error.Write("Feishu is not running; open Feishu first");
                        return 1;
                    }
                    // Exact text from the accessibility tree first; OCR only when
                    // the frame exposes nothing (older build, a11y disabled).
                    if (Environment.GetEnvironmentVariable("DSH_WORK_FORCE_OCR") != "1")
                    {
                        try
                        {
                            List<Line> lines = ReadUia(info);
                            if (lines.Count >= 12)
                            {
                                EmitCapture(new Captured { Info = info, Lines = lines }, true, "uia");
                                return 0;
                            }
                        }
                        catch
                        {
                            // Fall through to OCR.
                        }
                    }
                    EmitCapture(CaptureWithOcr(info), true, "ocr");
                    return 0;
                }

                default:
                {
                    int pid;
                    if (!int.TryParse(args[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out pid))
                    {
                        Console.Error.Write("unknown argument: " + args[0]);
                        return 2;
                    }
                    long explicitHandle = 0;
                    if (args.Length > 1) long.TryParse(args[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out explicitHandle);
                    WindowInfo info = ChooseWindow(pid, explicitHandle, explicitHandle == 0);
                    if (info == null)
                    {
                        Console.Error.Write("no window found for pid " + pid);
                        return 1;
                    }
                    EmitCapture(CaptureWithOcr(info), false, "ocr");
                    return 0;
                }
            }
        }
        catch (Exception error)
        {
            Console.Error.Write(error.Message);
            return 1;
        }
    }
}
