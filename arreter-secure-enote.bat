@echo off
cd /d "%~dp0"
docker compose down
echo Application arretee.
timeout /t 5
