@echo off
rem Serves Tellybox locally at http://localhost:8080 (kid app) and /admin.html
cd /d "%~dp0"
start "" http://localhost:8080/
python -m http.server 8080
