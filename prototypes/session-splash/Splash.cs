// Swiff session splash - a borderless, top-most, full-screen cover shown the instant the renter's
// session starts, so the renter never sees the bare desktop, the logon spinner, or Steam launching.
// It stays up until the host signals the stream is live (a ready-flag file appears), then fades out.
//
// Deliberately dependency-free and compiled to a tiny exe so it launches in well under a second.
//
// Signalling:
//   ready    - C:\ProgramData\Swiff\session\ready.flag exists  -> fade out and exit
//   status   - C:\ProgramData\Swiff\session\status.txt        -> its text replaces the subtitle
//   timeout  - a safety cap so a stuck session never traps the screen forever
//   Esc      - dev only; ignored unless started with --dev

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Windows.Forms;

static class Program {
    [STAThread]
    static void Main(string[] args) {
        bool dev = Array.IndexOf(args, "--dev") >= 0;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Splash(dev));
    }
}

sealed class Splash : Form {
    const string Dir     = @"C:\ProgramData\Swiff\session";
    const string Ready   = Dir + @"\ready.flag";
    const string Status  = Dir + @"\status.txt";
    readonly int TimeoutMs = 120000;   // safety: never trap the screen longer than this

    readonly Color Bg     = Color.FromArgb(14, 17, 22);
    readonly Color Fg     = Color.FromArgb(235, 238, 242);
    readonly Color Muted  = Color.FromArgb(150, 160, 172);
    readonly Color Accent = Color.FromArgb(88, 150, 240);

    readonly Timer _anim = new Timer();
    readonly Timer _poll = new Timer();
    readonly DateTime _start = DateTime.UtcNow;
    double _phase;
    bool _closing;
    string _subtitle = "Preparing isolated gaming environment";
    readonly bool _dev;

    public Splash(bool dev) {
        _dev = dev;

        FormBorderStyle = FormBorderStyle.None;
        StartPosition   = FormStartPosition.Manual;
        Bounds          = Screen.PrimaryScreen.Bounds;   // cover the whole primary display
        TopMost         = true;
        ShowInTaskbar   = false;
        BackColor       = Bg;
        DoubleBuffered  = true;
        Cursor.Hide();
        KeyPreview = true;

        _anim.Interval = 33;                 // ~30 fps for the spinner
        _anim.Tick += (s, e) => { _phase += 0.09; Invalidate(); };
        _anim.Start();

        _poll.Interval = 250;
        _poll.Tick += (s, e) => Check();
        _poll.Start();

        KeyDown += (s, e) => { if (_dev && e.KeyCode == Keys.Escape) BeginClose(); };
        try { Directory.CreateDirectory(Dir); } catch { }
    }

    // Keep the cover on top even if something else grabs foreground.
    protected override void OnDeactivate(EventArgs e) {
        base.OnDeactivate(e);
        if (!_closing) { try { TopMost = true; BringToFront(); Activate(); } catch { } }
    }

    void Check() {
        try {
            if (File.Exists(Status)) {
                string t = File.ReadAllText(Status).Trim();
                if (t.Length > 0 && t != _subtitle) { _subtitle = t; Invalidate(); }
            }
        } catch { }

        if (File.Exists(Ready)) { BeginClose(); return; }
        if ((DateTime.UtcNow - _start).TotalMilliseconds > TimeoutMs) { BeginClose(); }
    }

    void BeginClose() {
        if (_closing) return;
        _closing = true;
        _poll.Stop();
        var fade = new Timer { Interval = 16 };
        fade.Tick += (s, e) => {
            Opacity -= 0.08;
            if (Opacity <= 0.02) { fade.Stop(); _anim.Stop(); Close(); }
        };
        fade.Start();
    }

    protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics;
        g.SmoothingMode     = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

        int cx = Width / 2, cy = Height / 2;

        // Wordmark
        using (var wf = new Font("Segoe UI", 46f, FontStyle.Bold))
        using (var b = new SolidBrush(Fg)) {
            DrawCentered(g, "Swiff", wf, b, cx, cy - 90);
        }

        // Spinner: an arc sweeping around a ring
        int r = 26, ringY = cy + 4;
        using (var track = new Pen(Color.FromArgb(40, 255, 255, 255), 4f))
            g.DrawEllipse(track, cx - r, ringY - r, r * 2, r * 2);
        using (var arc = new Pen(Accent, 4f) { StartCap = LineCap.Round, EndCap = LineCap.Round }) {
            float sweep = 90f;
            float startAngle = (float)(_phase * 180.0 / Math.PI) % 360f;
            g.DrawArc(arc, cx - r, ringY - r, r * 2, r * 2, startAngle, sweep);
        }

        // Subtitle
        using (var sf = new Font("Segoe UI", 14f, FontStyle.Regular))
        using (var b = new SolidBrush(Muted)) {
            DrawCentered(g, _subtitle, sf, b, cx, cy + 78);
        }

        // Reassurance line
        using (var sf = new Font("Segoe UI", 10f, FontStyle.Regular))
        using (var b = new SolidBrush(Color.FromArgb(90, 100, 112))) {
            DrawCentered(g, "This machine is running an isolated session. Please wait.", sf, b, cx, cy + 108);
        }
    }

    static void DrawCentered(Graphics g, string text, Font f, Brush b, int cx, int cy) {
        SizeF sz = g.MeasureString(text, f);
        g.DrawString(text, f, b, cx - sz.Width / 2, cy - sz.Height / 2);
    }
}
