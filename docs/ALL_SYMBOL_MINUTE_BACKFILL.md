# All-Symbol 1-Minute Backfill — Research Coverage Pilot

## 목적

조건검색/성과검증 프로젝트가 전장→상대우위→종목 Alpha를 좁힌 뒤 분봉으로 target/stop 선후관계, MFE/MAE, time-to-MFE를 정밀검증할 수 있도록 **전종목 1분봉 historical coverage**를 구축한다.

정상 `npm run data:update`의 selective minute universe 정책은 유지한다. 전종목 backfill은 연구용 별도 작업이며 normal updater에 자동 편입하지 않는다.

## 원칙

- SSOT는 계속 `korean_equity_minute_1m` 한 논리 테이블이다.
- 수집/재처리는 월 단위로 잘라 장애 범위를 제한한다.
- MySQL insert는 기존 PK `(instrument_id, bar_timestamp)` upsert라 재실행 가능하다.
- 물리 MySQL partition ALTER는 현재 즉시 수행하지 않는다. 먼저 실제 월별 row 수/조회시간/백업시간을 측정한 뒤 결정한다.
- `.runtime/cybos/minute/all-symbol-backfill/YYYY-MM/batch-*`는 disposable staging이다.
- 데이터 부족은 조건실패로 취급하지 않는다. coverage 상태를 별도로 계산한다.

## 1. 현재 coverage 측정

예:

```powershell
Set-Location E:\market-data-factory
npm run data:minute:audit -- --from 2026-08-01 --to 2026-08-31
```

산출물 기본 위치:

```text
.runtime/audit/minute-coverage.json
```

핵심 값:
- eligible_instrument_days: 일봉에 존재하는 종목×거래일
- covered_instrument_days: 분봉이 1개 이상 존재하는 종목×거래일
- overall_instrument_day_coverage_ratio
- 일자별 minute_instruments / eligible_instruments
- 일자별 typical_bar_count
- 월별 row_count / instrument_count / trading_days

`typical_bar_count`는 해당 날짜 분봉 보유 종목의 bar_count 중앙값이다. 이는 NXT/거래소 세션의 절대 expected bar 수가 아니라 **현재 coverage 진단용 기준**이다.

## 2. Dry-run

전종목 월 단위 backfill runner는 기본적으로 실행하지 않고 계획만 출력한다.

```powershell
npm run data:minute:backfill-all -- --from 2026-08-01 --to 2026-08-31 --batch-size 25 --limit 100
```

`--limit 100`으로 첫 PoC를 수행한다. 현재 stock master의 KOSPI/KOSDAQ 종목을 코드순으로 잘라 사용한다.

## 3. 100종목 실제 PoC

CYBOS Plus가 연결된 Windows host에서:

```powershell
npm run data:minute:backfill-all -- --from 2026-08-01 --to 2026-08-31 --batch-size 25 --limit 100 --execute
```

측정할 것:
- 총 소요시간
- CYBOS rate-limit 대기/실패
- 수집 row 수
- import 시간
- DB row 증가량
- 동일 작업 재실행 시 idempotent 여부
- coverage 증가량

완료 후 동일 audit를 다시 실행한다.

## 4. 전체 종목 확장

100종목 PoC가 안정적이면 `--limit`을 제거한다.

```powershell
npm run data:minute:backfill-all -- --from 2026-08-01 --to 2026-08-31 --batch-size 25 --execute
```

한 달 성공 후 3개월→6개월→연구기간 순서로 확대한다. 여러 해를 한 번에 요청하더라도 runner 내부에서는 월 단위 slice로 처리한다.

## 5. 테이블 분할 정책

현재 단계에서 `minute_202601` 같은 테이블을 전략코드가 직접 참조하는 구조는 금지한다.

향후 데이터량이 커지면 다음 우선순위로 검토한다.

```text
논리 테이블 korean_equity_minute_1m 유지
→ trading_date 기반 MySQL RANGE partition benchmark
→ 연구용 month-partitioned Parquet mirror benchmark
→ hot MySQL + cold Parquet/columnar archive 필요성 판단
```

물리 partition 전환은 기존 PK/unique key와 MySQL partition key 제약을 검토한 별도 migration으로 수행한다. 현재 생산 테이블에 즉흥 ALTER를 실행하지 않는다.

## 6. 한계

현재 stock master는 현재 상장 universe 중심이므로 과거 상장폐지/코드변경 종목까지 완전한 survivorship-free universe를 보장하지 않는다. 전종목 historical backfill의 최종 계약은 `market_instrument`의 historical active interval 또는 과거 master snapshot을 사용해야 한다.

따라서 이번 Pilot의 목적은 먼저:

1. 현행 전종목 수집 가능성
2. 월 단위 처리시간/용량
3. MySQL upsert 안정성
4. 분봉 path engine에 필요한 coverage 확보속도

를 실측하는 것이다.
