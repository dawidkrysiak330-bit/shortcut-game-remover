"""YT Audio - pobieranie samego dźwięku z linku YouTube (MP3 / WAV / M4A).

Używaj do własnych utworów lub treści, do których masz prawa.
Wymaga: Python 3.9+, pakiety yt-dlp oraz imageio-ffmpeg (instaluje start.bat).
"""
import os
import queue
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

try:
    import yt_dlp
    import imageio_ffmpeg
except ImportError:
    tk.Tk().withdraw()
    messagebox.showerror(
        "Brak bibliotek",
        "Zainstaluj biblioteki poleceniem:\n\npip install -U yt-dlp imageio-ffmpeg\n\n"
        "albo uruchom aplikację przez start.bat",
    )
    raise SystemExit(1)

FORMATS = {
    "MP3 (320 kbps)": ("mp3", "320"),
    "WAV (bez strat)": ("wav", None),
    "M4A (oryginał, bez konwersji)": ("m4a", None),
}


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("YT Audio")
        self.geometry("560x260")
        self.resizable(False, False)
        self.msgs = queue.Queue()

        pad = {"padx": 10, "pady": 6}
        tk.Label(self, text="Link do YouTube:").grid(row=0, column=0, sticky="w", **pad)
        self.url = tk.Entry(self, width=55)
        self.url.grid(row=0, column=1, columnspan=2, sticky="we", **pad)
        self.url.bind("<Return>", lambda e: self.start())
        tk.Button(self, text="Wklej", command=self.paste).grid(row=0, column=3, **pad)

        tk.Label(self, text="Zapisz w:").grid(row=1, column=0, sticky="w", **pad)
        default_dir = os.path.join(os.path.expanduser("~"), "Music")
        if not os.path.isdir(default_dir):
            default_dir = os.path.expanduser("~")
        self.folder = tk.StringVar(value=default_dir)
        tk.Entry(self, textvariable=self.folder, width=55).grid(row=1, column=1, columnspan=2, sticky="we", **pad)
        tk.Button(self, text="Wybierz…", command=self.pick).grid(row=1, column=3, **pad)

        tk.Label(self, text="Format:").grid(row=2, column=0, sticky="w", **pad)
        self.fmt = tk.StringVar(value=list(FORMATS)[0])
        ttk.Combobox(self, textvariable=self.fmt, values=list(FORMATS), state="readonly", width=30).grid(
            row=2, column=1, sticky="w", **pad
        )

        self.btn = tk.Button(self, text="Pobierz dźwięk", command=self.start, width=20, bg="#2d7d46", fg="white")
        self.btn.grid(row=3, column=1, sticky="w", **pad)

        self.bar = ttk.Progressbar(self, length=520, mode="determinate")
        self.bar.grid(row=4, column=0, columnspan=4, **pad)
        self.status = tk.Label(self, text="Wklej link i kliknij „Pobierz dźwięk”.", anchor="w")
        self.status.grid(row=5, column=0, columnspan=4, sticky="we", **pad)

        self.after(100, self.poll)

    def paste(self):
        try:
            self.url.delete(0, tk.END)
            self.url.insert(0, self.clipboard_get().strip())
        except tk.TclError:
            pass

    def pick(self):
        d = filedialog.askdirectory(initialdir=self.folder.get())
        if d:
            self.folder.set(d)

    def start(self):
        url = self.url.get().strip()
        if not url:
            messagebox.showwarning("Brak linku", "Wklej link do filmu.")
            return
        os.makedirs(self.folder.get(), exist_ok=True)
        self.btn.config(state="disabled")
        self.bar["value"] = 0
        threading.Thread(target=self.download, args=(url, self.folder.get(), self.fmt.get()), daemon=True).start()

    def hook(self, d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            pct = d.get("downloaded_bytes", 0) * 100 / total if total else 0
            self.msgs.put(("progress", pct, f"Pobieranie… {pct:.0f}%"))
        elif d["status"] == "finished":
            self.msgs.put(("progress", 100, "Konwersja audio…"))

    def download(self, url, folder, fmt_label):
        codec, quality = FORMATS[fmt_label]
        opts = {
            "format": "bestaudio[ext=m4a]/bestaudio/best" if codec == "m4a" else "bestaudio/best",
            "outtmpl": os.path.join(folder, "%(title)s.%(ext)s"),
            "noplaylist": True,
            "ffmpeg_location": imageio_ffmpeg.get_ffmpeg_exe(),
            "progress_hooks": [self.hook],
            "quiet": True,
            "no_warnings": True,
            "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": codec, **({"preferredquality": quality} if quality else {})}],
        }
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
            self.msgs.put(("done", f"Gotowe: {info.get('title', 'plik')}.{codec}  →  {folder}"))
        except Exception as e:  # noqa: BLE001
            self.msgs.put(("error", str(e)))

    def poll(self):
        try:
            while True:
                m = self.msgs.get_nowait()
                if m[0] == "progress":
                    self.bar["value"], text = m[1], m[2]
                    self.status.config(text=text)
                elif m[0] == "done":
                    self.bar["value"] = 100
                    self.status.config(text=m[1])
                    self.btn.config(state="normal")
                else:
                    self.status.config(text="Błąd – szczegóły w okienku.")
                    self.btn.config(state="normal")
                    messagebox.showerror("Błąd", m[1])
        except queue.Empty:
            pass
        self.after(100, self.poll)


if __name__ == "__main__":
    App().mainloop()
