# market-data-factory

Shared market-data SSOT and Data Add-on factory.

The repository owns dataset contracts, collectors/updaters, schema migrations, access examples, integrity checks, and the Data Add-on catalog. Actual market data lives in MySQL rather than inside experiment-project folders.

## Local MySQL configuration

Create `E:\market-data-factory\.env` from `.env.example` and set the real connection URL:

```dotenv
MYSQL_URL=mysql://<user>:<password>@127.0.0.1:3306/market_data
```

`.env` is intentionally ignored by Git and must never be committed. Application code must obtain the connection through `src/db/mysql.mjs`; Data Add-ons must not duplicate credentials or hard-code host/user/password values.

## Bootstrap / verification

```powershell
Set-Location "E:\market-data-factory"
npm install
npm test
npm run db:check
```

`npm test` validates the environment contract without requiring a live database. `npm run db:check` reads the local `.env`, opens a real MySQL connection, and reports the selected database and server version.

## Data Add-on rule

Each dataset will be added as a detachable Data Add-on. A Data Add-on should own its source contract, schema/migrations, ingestion/update logic, quality checks, canonical access SQL/examples, and current state. Consumers should discover datasets through this repository rather than searching old experiment repositories for CSV files or updater scripts.
