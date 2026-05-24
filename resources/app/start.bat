@echo off
title AirBridge Launcher
cd /d "%~dp0"
node launcher.js
if %errorlevel% neq 0 (
    echo.
    echo -------------------------------------------------------------
    echo Launch failed.
    echo Please make sure Node.js is installed and port 3000/3001 is free.
    echo To build a standalone executable that doesn't need Node.js,
    echo run: npm run build-win
    echo -------------------------------------------------------------
    pause
)
