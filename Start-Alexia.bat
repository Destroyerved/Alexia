@echo off
title Alexia — Autonomous DevSecOps Guardian Server
cd /d "%~dp0"
if exist "AlexiaServer.exe" (
    "AlexiaServer.exe" %*
) else (
    python launcher.py %*
)
pause
