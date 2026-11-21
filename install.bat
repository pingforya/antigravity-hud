@echo off
rem Kept for compatibility: delegates to patch.bat (process check + backup + verify + rollback).
call "%~dp0patch.bat" %*
exit /b %errorlevel%
