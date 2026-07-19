@echo off
py -3 "%~dp0codex-attention-hook" >nul 2>nul
echo {"continue":true}
exit /b 0
