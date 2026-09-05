@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
cd /d "%~dp0"
py -3.13 market_data_ui.py
if errorlevel 1 (
  echo.
  echo UI failed to start. Confirm that 64-bit Python 3.13 and tkinter are installed.
  pause
)
