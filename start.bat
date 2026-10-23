@echo off
rem Double-click launcher for the Special Pomodoro app
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
