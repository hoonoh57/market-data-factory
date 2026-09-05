@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo Market Data Factory Update
echo ========================================
echo.
echo Updates:
echo   1. Korean equity daily data
echo   2. Korean equity 1-minute data
echo.
echo Completed-session policy:
echo   - Before 20:00 KST: today is excluded; older completed gaps still catch up
echo   - At/after 20:00 KST: today's completed session becomes eligible
echo.
echo Universe:
echo   - Every EQUITY instrument in market_instrument
echo   - Each symbol resumes from its own MAX(trading_date) + 1
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
