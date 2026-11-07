using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

class HighlightTarget : Form {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    readonly Button button = new Button();
    readonly string readyFile;
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get { var value = base.CreateParams; value.ExStyle |= 0x08000000; return value; }
    }
    HighlightTarget(string path) {
        readyFile = path;
        Text = "Kaji Highlight Test";
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(Screen.PrimaryScreen.WorkingArea.Left + 40, Screen.PrimaryScreen.WorkingArea.Top + 80);
        ClientSize = new Size(360, 140);
        button.Text = button.AccessibleName = "Highlight check";
        button.SetBounds(80, 45, 180, 45);
        Controls.Add(button);
    }
    protected override void OnLoad(EventArgs e) {
        base.OnLoad(e);
        SetWindowPos(Handle, new IntPtr(1), 0, 0, 0, 0, 0x0013);
    }
    protected override void OnShown(EventArgs e) {
        base.OnShown(e);
        SetWindowPos(Handle, new IntPtr(1), 0, 0, 0, 0, 0x0013);
        Rect r; GetWindowRect(button.Handle, out r);
        File.WriteAllText(readyFile, string.Format("{{\"left\":{0},\"top\":{1},\"right\":{2},\"bottom\":{3}}}", r.left, r.top, r.right, r.bottom));
    }
    [STAThread] static void Main(string[] args) {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        Application.EnableVisualStyles();
        Application.Run(new HighlightTarget(args[0]));
    }
}
