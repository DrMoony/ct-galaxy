@echo off
cd /d "%~dp0"
echo Starting CT-Galaxy server...
echo Open http://localhost:8080 in your browser
echo Press Ctrl+C to stop
echo.
start "" "http://localhost:8080"
py -m http.server 8080 --bind 127.0.0.1
