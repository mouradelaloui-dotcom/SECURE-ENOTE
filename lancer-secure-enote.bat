@echo off
cd /d "%~dp0"
echo Lancement de SECURE-eNOTE... (2 a 5 minutes la premiere fois)
echo ==== %date% %time% ==== > lancement.log
docker version >> lancement.log 2>&1
docker compose up -d --build >> lancement.log 2>&1
echo ==== ETAT ==== >> lancement.log
docker compose ps >> lancement.log 2>&1
echo ==== JOURNAUX APP ==== >> lancement.log
docker compose logs --tail 60 app db proxy >> lancement.log 2>&1
echo ==== FIN ==== >> lancement.log
type lancement.log
echo.
echo Ouvrez https://localhost:8443 dans votre navigateur.
timeout /t 15
