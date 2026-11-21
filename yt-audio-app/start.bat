@echo off
cd /d "%~dp0"
where python >nul 2>nul || (
  echo Nie znaleziono Pythona. Zainstaluj go z https://www.python.org/downloads/ ^(zaznacz "Add python.exe to PATH"^).
  pause
  exit /b 1
)
echo Sprawdzam / aktualizuje biblioteki...
python -m pip install -q -U yt-dlp imageio-ffmpeg
start "" pythonw yt_audio.py
