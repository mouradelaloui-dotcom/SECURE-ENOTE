@echo off
cd /d "%~dp0"
echo ATTENTION : la base de donnees, les sauvegardes et le certificat vont etre supprimes puis recrees.
pause
docker compose down -v > lancement.log 2>&1
call "%~dp0lancer-secure-enote.bat"
