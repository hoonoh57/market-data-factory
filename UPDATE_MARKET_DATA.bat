@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo Market Data Factory Update
echo ========================================
echo.
echo Updates:
echo   1. Korean equity daily data
 2. Korean equity 1-minute data

echo Minute update policy:
echo   - Before 20:00 KST: current trading session is skipped safely

echo   - After completed session: KRX300 + daily movers ^>= 15%%
echo   - New minute symbols: backfill recent 6 months
  - Existing minute symbols: incremental update

echo.
call npm run data:update
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo Update finished successfully.
) else (
  echo Update failed. Exit code=%EXIT_CODE%
)
echo.
pause
exit /b %EXIT_CODE%
